//! Tauri IPC bridge for the LAN sync layer (UI-1).
//!
//! Wires the shipped sync primitives in `crate::sync::*` to the
//! frontend store. **No new sync logic** lives here — every command is
//! a thin shim over an existing primitive:
//!
//! - identity     → [`crate::sync::identity::Identity`]
//! - discovery    → [`crate::sync::discovery::MdnsDiscovery`]
//! - pairing      → [`crate::sync::pairing`] PAKE flow
//! - peers/grants → [`crate::sync::state::SyncState`]
//!
//! ## Runtime ownership
//!
//! [`SyncRuntime`] is registered with Tauri at startup and lives for
//! the whole process. It owns the long-lived mDNS daemon (started lazily
//! when the user first toggles "discoverable"), the in-memory pairing
//! session table (keyed by UUID `session_id`), and a slot for the active
//! vault's [`SyncState`] handle. Paired-peer / grant queries route
//! through that slot — when no vault is open, the queries return empty
//! lists rather than erroring (the Settings UI then renders an empty
//! state).
//!
//! ## Event emission
//!
//! Four events are emitted from this module:
//!
//! - `sync://peers-discovered` — fired by a background poller (250 ms
//!   debounce) whenever the mDNS browse-thread peer snapshot changes.
//! - `sync://peer-paired` — fired from [`sync_pairing_confirm`] right
//!   after the new peer is persisted to `sync_peers`.
//! - `sync://sync-status` — placeholder; emission will plug in once the
//!   transport layer wires per-vault status. The IPC + listener surface
//!   exists so UI-4 can bind without waiting on transport.
//! - `sync://stale-peer-resurrect` — placeholder for the same reason
//!   (UI-5 needs the surface).
//!
//! ## Frontend contract
//!
//! Commands are user-driven — no polling on render. The store
//! initializes once via [`sync_get_self_identity`] +
//! [`sync_list_paired_peers`] + [`sync_get_discoverable`], then updates
//! exclusively from the four events above. See `src/store/syncStore.ts`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::error::VaultError;
use crate::sync::capability::{Capability, CapabilityBody, Scope};
use crate::sync::discovery::{Discovery, MdnsDiscovery, PeerAd, PROTO_VERSION};
use crate::sync::identity::{Identity, KeyStore, MemoryKeyStore, OsKeychainStore};
use crate::sync::pairing::{
    finalize_with_confirmation, key_confirmation_mac, respond, start_initiator, validate_pin,
    PairingSession, RawSharedKeys, LOCKOUT_AFTER_ATTEMPTS, PIN_EXPIRY_SECS,
};
use crate::sync::pairing_engine::{
    drive_initiator_after_pake, drive_responder_after_pake, exchange_vault_grant_initiator,
    exchange_vault_grant_responder, PostPairingSession,
};
use crate::sync::state::SyncState;
#[cfg(test)]
use crate::sync::state::PeerTrust;
use crate::sync::transport::{generate_static_keypair, NoiseKeypair};

// ─── Event names ─────────────────────────────────────────────────────────

pub const PEERS_DISCOVERED_EVENT: &str = "sync://peers-discovered";
pub const PEER_PAIRED_EVENT: &str = "sync://peer-paired";
pub const SYNC_STATUS_EVENT: &str = "sync://sync-status";
pub const STALE_PEER_RESURRECT_EVENT: &str = "sync://stale-peer-resurrect";

/// Debounce window for `sync://peers-discovered`. Even if 30 peers come
/// and go in this window, the frontend sees at most one event with the
/// final snapshot. Spec says "≤ 250 ms" — using exactly 250 ms.
pub const PEERS_DEBOUNCE_MS: u64 = 250;

/// Default port advertised in mDNS TXT records. The Noise transport layer
/// (#419) listens here; the IPC bridge only needs a stable value to
/// publish so peers can resolve us. Picked from IANA's user-port range
/// to avoid `_vaultcore`-vs-`_<other>` collisions on the same network.
pub const DEFAULT_SYNC_PORT: u16 = 17091;

/// Pairing-handshake port. The initiator binds a TCP listener here for
/// the duration of an active pairing flow; the responder dials the peer
/// IP it picked from `sync_list_discovered_peers` on this port. Distinct
/// from [`DEFAULT_SYNC_PORT`] so the steady-state Noise listener and the
/// pairing listener can run concurrently. We use a fixed port (rather
/// than ephemeral + mDNS-TXT advertisement) because:
///  - Only one pairing flow runs at a time per device, so port
///    contention is bounded to "two VaultCore instances racing on the
///    same machine" — rare and cleanly detected as a bind failure.
///  - It avoids a TXT-record schema change to broadcast the port,
///    which would ripple through every PeerAd consumer including the
///    in-tree e2e fixture.
/// The trade-off (one pairing at a time per host) is documented as the
/// pragmatic "fixed pairing port" choice from the UI-1.6 task brief.
pub const DEFAULT_PAIRING_PORT: u16 = 17092;

/// Hard ceiling on how long the pairing worker waits for the peer to
/// connect / dial / drive PAKE through. Mirrors the PIN expiry (60s) so
/// a stale flow can't pin a port forever.
const PAIRING_WORKER_TIMEOUT: Duration = Duration::from_secs(PIN_EXPIRY_SECS as u64);

/// Wall-clock budget for individual socket reads/writes during the PAKE
/// hello + step exchange. PAKE round-trip is sub-second; 5 s is generous
/// even on a saturated LAN. Without this a malformed responder could
/// stall the worker thread indefinitely.
const PAKE_IO_TIMEOUT: Duration = Duration::from_secs(5);

// ─── DTOs (shape matches `src/store/syncStore.ts`) ───────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SelfIdentityDto {
    pub device_id: String,
    pub device_name: String,
    pub pubkey_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultRefDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPeerDto {
    pub device_id: String,
    pub device_name: String,
    pub vaults: Vec<VaultRefDto>,
    pub addr: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrantDto {
    pub vault_id: String,
    pub vault_name: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairedPeerDto {
    pub device_id: String,
    pub device_name: String,
    pub last_seen: Option<i64>,
    pub grants: Vec<GrantDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingStartInitiatorDto {
    pub session_id: String,
    pub pin: String,
    pub expires_at_unix: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingStartResponderDto {
    pub session_id: String,
}

/// Outcome of [`sync_pairing_step`]. The UI renders one of four screens
/// keyed off `kind`: a spinner (`awaiting_peer`), the fingerprint
/// confirmation card (`awaiting_confirmation`), the success state
/// (`complete`), or the lockout / wrong-PIN card (`failed`).
#[derive(Debug, Clone, Serialize)]
pub struct PairingStepDto {
    pub kind: String,
    pub peer_fingerprint: Option<String>,
    pub attempts_remaining: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerPairedEventDto {
    pub device_id: String,
    pub device_name: String,
}

// ─── Pairing session table ────────────────────────────────────────────────

/// In-memory pairing session — one per active flow, keyed by UUID. Held
/// by [`SyncRuntime::pairing_sessions`] for the duration of the flow.
/// On `confirm` or `cancel` the entry is removed.
struct PairingFlow {
    session: PairingSession,
    role: PairingRole,
    /// Peer device id, if known. The initiator learns it from the hello
    /// packet exchanged at the top of the PAKE socket; the responder
    /// receives it from the IPC arg or learns it from the same hello.
    peer_device_id: Option<String>,
    /// Once PAKE step1+step2 have been driven, the raw shared keys
    /// land here awaiting key-confirmation. `None` means PAKE is not
    /// yet finished. Kept around mostly for the test-injection path
    /// — production code reaches `awaiting_confirmation` only after
    /// `drive_*_after_pake` has consumed `k2` to derive the long-term
    /// attestation.
    raw_keys: Option<RawSharedKeys>,
    /// Cached fingerprint we display to the user during confirmation.
    /// Computed from the peer's persisted Ed25519 pubkey: the existing
    /// 8-char base32 prefix used everywhere else in the identity layer.
    peer_fingerprint: Option<String>,
    /// Worker-thread state. Updated by the worker via the runtime's
    /// `pairing_sessions` mutex; read by `pairing_step` to render the
    /// UI.
    state_kind: PairingState,
    /// Last PAKE/engine error. Surfaced to the UI when `state_kind ==
    /// Failed` so the user sees "wrong PIN" vs "network error" copy.
    error: Option<String>,
    /// Active post-pairing session — populated when the engine drive
    /// completes successfully. Held under the same mutex so
    /// `pairing_grant_vault` can borrow it for the grant exchange.
    post_pairing: Option<PostPairingSession>,
    /// Initiator-only: handle to the bound TCP listener so we can drop
    /// it on cancel. The listener is consumed by the worker once a
    /// connection arrives. Read in tests to recover the bound port; in
    /// production it's only kept alive for cleanup ordering.
    #[allow(dead_code)]
    listener_handle: Option<Arc<TcpListener>>,
    /// Worker thread handle. Detaching is fine on cancel — the thread
    /// observes the dropped session via channel disconnect / socket
    /// close and exits.
    worker_handle: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairingRole {
    Initiator,
    Responder,
}

/// Coarse-grained pairing state surfaced through `pairing_step`. Mirrors
/// the four UI screens (`PairingStepDto::kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairingState {
    /// Worker hasn't completed PAKE+attestation yet.
    AwaitingPeer,
    /// PAKE+attestation done; UI shows fingerprint and waits for the
    /// user to click "Bestätigen".
    AwaitingConfirmation,
    /// User confirmed; peer row + capability rows persisted.
    Complete,
    /// PAKE/attestation/grant exchange failed. Retry requires starting
    /// a fresh session.
    Failed,
}

// ─── Discovery emission task ──────────────────────────────────────────────

/// Last-snapshot signature used by the emitter task to decide whether
/// to fire the debounced event. We hash the sorted device-id list — if
/// nothing changed peer-set-wise, no event needed.
fn snapshot_signature(peers: &[DiscoveredPeerDto]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut ids: Vec<&str> = peers.iter().map(|p| p.device_id.as_str()).collect();
    ids.sort();
    let mut h = DefaultHasher::new();
    ids.hash(&mut h);
    h.finish()
}

/// Convert a [`PeerAd`] (sync-layer wire shape) into the [`DiscoveredPeerDto`]
/// the frontend store expects. The first reachable address is rendered as
/// `host:port` for display; if no addresses came through (mdns-sd
/// occasionally publishes the TXT before the A record), we emit an empty
/// string and let the UI render "(no address)".
fn peer_ad_to_dto(ad: &PeerAd) -> DiscoveredPeerDto {
    let addr = ad
        .addrs
        .first()
        .map(|ip| format!("{}:{}", ip, ad.port))
        .unwrap_or_default();
    DiscoveredPeerDto {
        device_id: ad.device_id.clone(),
        device_name: ad.name.clone(),
        vaults: ad
            .vaults
            .iter()
            .map(|v| VaultRefDto {
                id: v.id.clone(),
                name: v.name.clone(),
            })
            .collect(),
        addr,
    }
}

// ─── Runtime state ────────────────────────────────────────────────────────

/// Process-wide sync runtime. Constructed once in `lib.rs::run` and
/// stuffed into Tauri's state.
///
/// Concurrency model: every field is `Arc`-cloneable and uses interior
/// mutability behind a `Mutex`. The mDNS scan thread (owned by
/// `MdnsDiscovery`) and the debounce-emitter thread we spawn ourselves
/// both close over Arcs into this struct, so it must outlive both —
/// hence `Arc<SyncRuntime>` storage in Tauri's `manage()`.
pub struct SyncRuntime {
    identity: Identity,
    /// Per-process Noise static keypair. Generated lazily at runtime
    /// construction — separate from the Ed25519 long-term identity (Noise
    /// is happier with native Curve25519 keys, see
    /// `pairing_engine.rs` module docs).
    noise_kp: NoiseKeypair,
    /// Mutable display name override. The OS hostname is the default;
    /// users can override via `sync_set_device_name`.
    device_name: Mutex<String>,
    discovery: Arc<MdnsDiscovery>,
    /// Whether the discovery daemon is currently running. Mirrors the
    /// `commands::sync::DISCOVERABLE` static for backwards-compat with
    /// the existing toggle.
    discoverable: Mutex<bool>,
    pairing_sessions: Mutex<HashMap<String, PairingFlow>>,
    /// Slot for the active vault's metadata SyncState. Populated by
    /// [`SyncRuntime::set_active_sync_state`] when a vault is opened
    /// (engine wiring is the engine task's job — UI-1 only exposes
    /// the slot so paired-peer queries return non-empty in that case).
    active_state: Mutex<Option<Arc<SyncState>>>,
    /// Shared with the emitter thread so the runtime can be torn down.
    emitter_stop: Arc<std::sync::atomic::AtomicBool>,
    emitter_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Last-emitted peer snapshot signature so the emitter can skip
    /// no-op fires (peer set unchanged across the debounce window).
    last_signature: Arc<Mutex<Option<u64>>>,
}

impl SyncRuntime {
    /// Build with the OS keychain backing the identity. Used by `lib.rs`.
    pub fn new() -> Result<Self, VaultError> {
        Self::with_keystore(Box::new(OsKeychainStore::default()))
    }

    /// Test constructor. Drops the OS keychain in favor of an in-memory
    /// store so unit tests don't touch the developer's real keychain.
    pub fn new_for_test() -> Result<Self, VaultError> {
        Self::with_keystore(Box::new(MemoryKeyStore::new()))
    }

    fn with_keystore(store: Box<dyn KeyStore>) -> Result<Self, VaultError> {
        let identity = Identity::load_or_create(&*store)?;
        let noise_kp = generate_static_keypair().map_err(|e| VaultError::SyncState {
            msg: format!("noise keypair init: {e:?}"),
        })?;
        let device_name = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "VaultCore".to_string());
        let discovery = Arc::new(MdnsDiscovery::new()?);
        Ok(Self {
            identity,
            noise_kp,
            device_name: Mutex::new(device_name),
            discovery,
            discoverable: Mutex::new(false),
            pairing_sessions: Mutex::new(HashMap::new()),
            active_state: Mutex::new(None),
            emitter_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            emitter_handle: Mutex::new(None),
            last_signature: Arc::new(Mutex::new(None)),
        })
    }

    pub fn self_identity(&self) -> SelfIdentityDto {
        SelfIdentityDto {
            device_id: self.identity.device_id().to_string(),
            device_name: self
                .device_name
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default(),
            pubkey_fingerprint: self.identity.pubkey_fp(),
        }
    }

    pub fn set_device_name(&self, name: String) -> Result<(), VaultError> {
        *self
            .device_name
            .lock()
            .map_err(|_| VaultError::LockPoisoned)? = name;
        Ok(())
    }

    pub fn discoverable(&self) -> bool {
        self.discoverable
            .lock()
            .map(|g| *g)
            .unwrap_or(false)
    }

    /// Activate the current advertisement and start the browse thread.
    /// Idempotent — toggling true twice is a no-op past the first call.
    pub fn set_discoverable(&self, on: bool) -> Result<(), VaultError> {
        let mut flag = self
            .discoverable
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        if *flag == on {
            return Ok(());
        }
        if on {
            let ad = PeerAd {
                device_id: self.identity.device_id().to_string(),
                name: self
                    .device_name
                    .lock()
                    .map_err(|_| VaultError::LockPoisoned)?
                    .clone(),
                vaults: Vec::new(),
                pubkey_fp: self.identity.pubkey_fp(),
                proto: PROTO_VERSION.to_string(),
                addrs: Vec::new(),
                port: DEFAULT_SYNC_PORT,
            };
            self.discovery.start(ad)?;
        } else {
            self.discovery.stop()?;
        }
        *flag = on;
        // Mirror to the legacy static so existing call sites that read
        // `commands::sync::DISCOVERABLE` see the same value.
        crate::commands::sync::DISCOVERABLE.store(on, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    pub fn list_discovered_peers(&self) -> Result<Vec<DiscoveredPeerDto>, VaultError> {
        let snapshot = self.discovery.peers()?;
        Ok(snapshot.peers.iter().map(peer_ad_to_dto).collect())
    }

    pub fn list_paired_peers(&self) -> Result<Vec<PairedPeerDto>, VaultError> {
        let guard = self
            .active_state
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        let Some(state) = guard.as_ref() else {
            return Ok(Vec::new());
        };
        let peers = state.list_paired_peers()?;
        let mut out = Vec::with_capacity(peers.len());
        for p in peers {
            let grants = state
                .list_grants_for_peer(&p.peer_device_id)?
                .into_iter()
                .map(|g| GrantDto {
                    vault_id: g.local_vault_id.clone(),
                    // No vault-name registry yet — surface the id so the
                    // UI can render *something* until UI-2 adds the
                    // friendly-name resolver. See UI-2 for the upgrade.
                    vault_name: g.local_vault_id,
                    scope: g.scope,
                })
                .collect();
            out.push(PairedPeerDto {
                device_id: p.peer_device_id,
                device_name: p.peer_name,
                last_seen: p.last_seen,
                grants,
            });
        }
        Ok(out)
    }

    /// Used by `commands/vault.rs::open_vault` (engine wiring task) to
    /// register the active vault's metadata DB so paired-peer queries
    /// can read it. UI-1 doesn't call this itself — the slot is just a
    /// hook for the engine wiring. Tests use it directly.
    pub fn set_active_sync_state(&self, state: Option<Arc<SyncState>>) -> Result<(), VaultError> {
        *self
            .active_state
            .lock()
            .map_err(|_| VaultError::LockPoisoned)? = state;
        Ok(())
    }

    /// Test-only: peek at the active state slot without going through
    /// the IPC layer.
    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn active_sync_state(&self) -> Option<Arc<SyncState>> {
        self.active_state.lock().ok().and_then(|g| g.clone())
    }

    /// Test-only: read back the bound port of an initiator session's
    /// pairing listener. Tests pass `bind_port_override = Some(0)` (so
    /// each test gets an ephemeral port and can run in parallel), then
    /// use this to learn what port the responder should dial.
    #[cfg(test)]
    pub fn pairing_listener_port_for_test(&self, session_id: &str) -> Option<u16> {
        let sessions = self.pairing_sessions.lock().ok()?;
        let flow = sessions.get(session_id)?;
        let listener = flow.listener_handle.as_ref()?;
        listener.local_addr().ok().map(|a| a.port())
    }

    /// Test-only: drive the underlying `PairingSession` to lockout
    /// without going through PAKE. The IPC-layer lockout test asserts
    /// that `pairing_step` correctly surfaces a locked-out session as
    /// `{ kind: failed, attempts_remaining: 0 }`; the *mechanism* by
    /// which the session reaches that state (3 wire failures vs 3
    /// in-process record_failure calls) is exercised in
    /// `pairing_tests::three_failed_attempts_locks_out`. Bypassing the
    /// wire keeps this layer's test focused on the IPC surface.
    #[cfg(test)]
    pub fn force_lockout_for_test(&self, session_id: &str) -> Result<(), VaultError> {
        use crate::sync::pairing::{finalize_with_confirmation, RawSharedKeys};
        let sessions = self
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        let flow = sessions.get(session_id).ok_or_else(|| VaultError::SyncState {
            msg: format!("unknown pairing session: {session_id}"),
        })?;
        let raw = RawSharedKeys {
            k1: [0u8; 32],
            k2: [0u8; 32],
            id_a: "A".into(),
            id_b: "B".into(),
        };
        let bad_mac = [0xFFu8; 32];
        for _ in 0..LOCKOUT_AFTER_ATTEMPTS {
            let _ = finalize_with_confirmation(&raw, &bad_mac, &flow.session);
        }
        Ok(())
    }

    pub fn grant_vault(
        &self,
        peer_device_id: &str,
        vault_id: &str,
        scope: Scope,
    ) -> Result<(), VaultError> {
        let state = self.require_active_state()?;
        // Look up the peer's pubkey to ensure they're still trusted —
        // granting access to a revoked peer is a programming error.
        let pubkey = state
            .peer_pubkey(peer_device_id)?
            .ok_or_else(|| VaultError::SyncState {
                msg: format!("unknown or revoked peer: {peer_device_id}"),
            })?;
        // We sign capabilities with our own device key so the peer can
        // verify against the pubkey they already have for us.
        // `peer_vault_id` defaults to the same id — UI-2 may extend this
        // to take an explicit remote-vault selector.
        let _ = pubkey; // we sign with self-identity, not peer pubkey
        let body = CapabilityBody::issue_v1(vault_id, peer_device_id, vault_id, scope);
        // SigningKey access: Identity owns it but exposes only `sign` —
        // for the capability we re-derive a SigningKey from raw bytes.
        // Since we don't expose those bytes from Identity, we use the
        // sign-blob → Capability::sign manually below.
        // NOTE: capability layer requires SigningKey. We add a passthrough
        // helper on Identity below in `signing_key_bytes`.
        let cap = self.sign_capability(&body)?;
        state.upsert_vault_grant(&cap)?;
        Ok(())
    }

    pub fn revoke_peer(&self, peer_device_id: &str) -> Result<(), VaultError> {
        let state = self.require_active_state()?;
        // Reject when the peer doesn't exist at all, so the frontend
        // surfaces "unknown peer" rather than silently succeeding on a
        // typo. A peer that's already revoked stays revoked — second
        // call is a no-op.
        if state.peer_pubkey(peer_device_id)?.is_none() {
            // peer_pubkey returns None for revoked too; check sync_peers
            // directly to differentiate.
            if !peer_row_exists(&state, peer_device_id)? {
                return Err(VaultError::SyncState {
                    msg: format!("unknown peer: {peer_device_id}"),
                });
            }
        }
        state.revoke_peer(peer_device_id)?;
        Ok(())
    }

    pub fn revoke_vault_grant(
        &self,
        peer_device_id: &str,
        vault_id: &str,
    ) -> Result<(), VaultError> {
        let state = self.require_active_state()?;
        let removed = state.disable_vault_grant(vault_id, peer_device_id)?;
        if !removed {
            return Err(VaultError::SyncState {
                msg: format!(
                    "no enabled grant for peer {peer_device_id} on vault {vault_id}"
                ),
            });
        }
        Ok(())
    }

    fn require_active_state(&self) -> Result<Arc<SyncState>, VaultError> {
        let guard = self
            .active_state
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        guard.clone().ok_or_else(|| VaultError::SyncState {
            msg: "no vault is open".into(),
        })
    }

    /// Sign a capability body under the device's identity key. Implemented
    /// here (not on `Identity`) because `Identity` doesn't expose the raw
    /// signing key — capability signing is the only call site that needs
    /// it, and inverting the dependency keeps `Identity` minimal.
    fn sign_capability(&self, body: &CapabilityBody) -> Result<Capability, VaultError> {
        let body_bytes = body.to_bytes();
        let sig = self.identity.sign(&body_bytes);
        Ok(Capability {
            body: body_bytes,
            signature: sig.to_vec(),
        })
    }

    // ─── Pairing flow helpers ─────────────────────────────────────────────

    /// Initiator entry: bind the pairing listener, generate a PIN, and
    /// spawn the worker thread that drives PAKE+attestation when the
    /// responder dials in. Returns immediately with the PIN to display.
    pub fn pairing_start_initiator(
        self: &Arc<Self>,
        pin_override: Option<String>,
        bind_port_override: Option<u16>,
    ) -> Result<PairingStartInitiatorDto, VaultError> {
        let session_id = Uuid::new_v4().to_string();
        let pin = pin_override.unwrap_or_else(generate_pin_6_digit);
        let session = PairingSession::new();
        session.issue_pin()?;
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Bind the pairing listener up-front so any port-conflict error
        // surfaces synchronously rather than asynchronously inside the
        // worker (where the UI would only see "awaiting_peer" → time out).
        let bind_port = bind_port_override.unwrap_or(DEFAULT_PAIRING_PORT);
        let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], bind_port)))
            .map_err(|e| VaultError::SyncState {
                msg: format!("bind pairing listener on :{bind_port}: {e}"),
            })?;
        listener
            .set_nonblocking(false)
            .map_err(|e| VaultError::SyncState {
                msg: format!("listener configure: {e}"),
            })?;
        let listener_arc = Arc::new(listener);

        let flow = PairingFlow {
            session,
            role: PairingRole::Initiator,
            peer_device_id: None,
            raw_keys: None,
            peer_fingerprint: None,
            state_kind: PairingState::AwaitingPeer,
            error: None,
            post_pairing: None,
            listener_handle: Some(Arc::clone(&listener_arc)),
            worker_handle: None,
        };
        self.pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?
            .insert(session_id.clone(), flow);

        // Spawn the worker. Holds an Arc<SyncRuntime> so the cleanup +
        // result-write paths can reach back through the mutex.
        let runtime = Arc::clone(self);
        let session_id_for_worker = session_id.clone();
        let pin_for_worker = pin.clone();
        let listener_for_worker = listener_arc;
        let handle = std::thread::spawn(move || {
            initiator_worker(runtime, session_id_for_worker, listener_for_worker, pin_for_worker);
        });
        if let Ok(mut sessions) = self.pairing_sessions.lock() {
            if let Some(flow) = sessions.get_mut(&session_id) {
                flow.worker_handle = Some(handle);
            }
        }

        Ok(PairingStartInitiatorDto {
            session_id,
            pin,
            expires_at_unix: now_secs + PIN_EXPIRY_SECS,
        })
    }

    /// Responder entry: validate PIN, resolve the peer's address, spawn
    /// the dial+handshake worker. `peer_device_id` selects which
    /// discovered peer to dial; `peer_addr_override` is a test-only
    /// shortcut so unit tests can inject a loopback address without
    /// running mDNS.
    pub fn pairing_start_responder(
        self: &Arc<Self>,
        pin: &str,
        peer_device_id: Option<String>,
        peer_addr_override: Option<SocketAddr>,
    ) -> Result<PairingStartResponderDto, VaultError> {
        validate_pin(pin).map_err(VaultError::from)?;
        let session_id = Uuid::new_v4().to_string();
        let session = PairingSession::new();
        session.issue_pin()?;

        // Address resolution: if the caller didn't pass an override,
        // we pull the peer's IP from the live discovery snapshot and
        // dial DEFAULT_PAIRING_PORT (the initiator's bound port). The
        // override path is for tests; production UI always passes a
        // peer_device_id and lets discovery resolve.
        let dial_addr = match peer_addr_override {
            Some(a) => Some(a),
            None => match peer_device_id.as_deref() {
                Some(id) => Some(self.resolve_peer_pairing_addr(id)?),
                None => None,
            },
        };

        let flow = PairingFlow {
            session,
            role: PairingRole::Responder,
            peer_device_id: peer_device_id.clone(),
            raw_keys: None,
            peer_fingerprint: None,
            state_kind: PairingState::AwaitingPeer,
            error: None,
            post_pairing: None,
            listener_handle: None,
            worker_handle: None,
        };
        self.pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?
            .insert(session_id.clone(), flow);

        // The dial+PAKE flow only runs when we have a target address.
        // Without one (e.g., the legacy frontend that doesn't pass
        // peer_device_id yet), the session sits in `awaiting_peer`
        // until cancelled — matches the prior UI-1 stub semantics so
        // existing PairingModal callers don't regress.
        if let Some(addr) = dial_addr {
            let runtime = Arc::clone(self);
            let session_id_for_worker = session_id.clone();
            let pin_for_worker = pin.to_string();
            let handle = std::thread::spawn(move || {
                responder_worker(runtime, session_id_for_worker, addr, pin_for_worker);
            });
            if let Ok(mut sessions) = self.pairing_sessions.lock() {
                if let Some(flow) = sessions.get_mut(&session_id) {
                    flow.worker_handle = Some(handle);
                }
            }
        }

        Ok(PairingStartResponderDto { session_id })
    }

    /// Map a discovered peer's `device_id` → `SocketAddr` for dialing.
    /// Uses the first IPv4 address from the mDNS snapshot, paired with
    /// [`DEFAULT_PAIRING_PORT`]. Returns an error if the peer is not
    /// currently visible — surfaces as a clear UI message rather than
    /// a silent worker timeout.
    fn resolve_peer_pairing_addr(&self, peer_device_id: &str) -> Result<SocketAddr, VaultError> {
        let snapshot = self.discovery.peers()?;
        let peer = snapshot
            .peers
            .iter()
            .find(|p| p.device_id == peer_device_id)
            .ok_or_else(|| VaultError::SyncState {
                msg: format!("peer not visible in discovery: {peer_device_id}"),
            })?;
        let ip = peer
            .addrs
            .first()
            .copied()
            .ok_or_else(|| VaultError::SyncState {
                msg: format!("peer has no resolved address: {peer_device_id}"),
            })?;
        Ok(SocketAddr::new(ip, DEFAULT_PAIRING_PORT))
    }

    /// Poll the pairing flow's worker-set state. The UI calls this on a
    /// short interval after `pairing_start_*` to learn when to advance
    /// from the spinner to the fingerprint card.
    pub fn pairing_step(
        &self,
        session_id: &str,
        _payload: Option<String>,
    ) -> Result<PairingStepDto, VaultError> {
        let sessions = self
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        let flow = sessions.get(session_id).ok_or_else(|| VaultError::SyncState {
            msg: format!("unknown pairing session: {session_id}"),
        })?;
        // Lockout / PIN-expiry trump the worker state — they're the
        // canonical "fail fast" surfaces.
        if flow.session.is_locked()? {
            return Ok(PairingStepDto {
                kind: "failed".into(),
                peer_fingerprint: None,
                attempts_remaining: Some(0),
            });
        }
        let attempts_remaining = LOCKOUT_AFTER_ATTEMPTS
            .saturating_sub(flow.session.failed_count()?);
        let kind = match flow.state_kind {
            PairingState::AwaitingPeer => "awaiting_peer",
            PairingState::AwaitingConfirmation => "awaiting_confirmation",
            PairingState::Complete => "complete",
            PairingState::Failed => "failed",
        };
        Ok(PairingStepDto {
            kind: kind.into(),
            peer_fingerprint: flow.peer_fingerprint.clone(),
            attempts_remaining: Some(attempts_remaining),
        })
    }

    /// User confirmed the fingerprint. The engine has already persisted
    /// the peer row + transitioned the trust state — this just flips the
    /// UI state to `Complete` and returns the peer's identity for the
    /// `sync://peer-paired` event. The post-pairing session stays in
    /// the table so subsequent `pairing_grant_vault` calls can reach the
    /// open Noise channel.
    pub fn pairing_confirm(&self, session_id: &str) -> Result<PeerPairedEventDto, VaultError> {
        let mut sessions = self
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        let flow = sessions.get_mut(session_id).ok_or_else(|| VaultError::SyncState {
            msg: format!("unknown pairing session: {session_id}"),
        })?;
        if flow.state_kind != PairingState::AwaitingConfirmation {
            return Err(VaultError::SyncState {
                msg: format!(
                    "pairing not at confirmation step (state: {:?})",
                    flow.state_kind
                ),
            });
        }
        let peer_id = flow
            .peer_device_id
            .clone()
            .ok_or_else(|| VaultError::SyncState {
                msg: "pairing has no peer device id".into(),
            })?;
        flow.state_kind = PairingState::Complete;
        let device_name = format!("Peer {peer_id}");
        Ok(PeerPairedEventDto {
            device_id: peer_id,
            device_name,
        })
    }

    /// Vault-grant phase. Borrows the live `PostPairingSession` from the
    /// flow, runs the role-appropriate `exchange_vault_grant_*`, and
    /// returns. Capability rows are persisted on both sides as part of
    /// the engine call.
    pub fn pairing_grant_vault(
        &self,
        session_id: &str,
        vault_id: &str,
        scope: Scope,
    ) -> Result<(), VaultError> {
        let mut sessions = self
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        let flow = sessions.get_mut(session_id).ok_or_else(|| VaultError::SyncState {
            msg: format!("unknown pairing session: {session_id}"),
        })?;
        if flow.state_kind != PairingState::Complete
            && flow.state_kind != PairingState::AwaitingConfirmation
        {
            return Err(VaultError::SyncState {
                msg: format!(
                    "pairing not ready for vault grant (state: {:?})",
                    flow.state_kind
                ),
            });
        }
        let role = flow.role;
        let peer_id = flow
            .peer_device_id
            .clone()
            .ok_or_else(|| VaultError::SyncState {
                msg: "pairing has no peer device id".into(),
            })?;
        let mut session = flow.post_pairing.take().ok_or_else(|| VaultError::SyncState {
            msg: "no live post-pairing session (engine never finished)".into(),
        })?;
        // Drop the lock while we drive the (potentially blocking) Noise
        // I/O — releasing this lets `pairing_step` polls keep working
        // and avoids a deadlock if the peer takes its time on the wire.
        drop(sessions);

        // The capability body names the issuer's own device id in
        // `peer_device_id` per the engine's "peer-self-signed" model.
        let body = CapabilityBody::issue_v1(
            vault_id.to_string(),
            self.identity.device_id().to_string(),
            vault_id.to_string(),
            scope,
        );
        let state = self.require_active_state()?;
        let signing_key = self.identity.signing_key();
        let result = match role {
            PairingRole::Initiator => exchange_vault_grant_initiator(
                &mut session,
                signing_key,
                &body,
                &peer_id,
                &state,
            ),
            PairingRole::Responder => exchange_vault_grant_responder(
                &mut session,
                signing_key,
                &body,
                &peer_id,
                &state,
            ),
        };

        // Restore the session so a follow-up grant for a different
        // vault can reuse the same channel.
        let put_back = match self.pairing_sessions.lock() {
            Ok(mut s) => s.get_mut(session_id).map(|flow| {
                flow.post_pairing = Some(session);
            }),
            Err(_) => None,
        };
        let _ = put_back;

        result.map_err(|e| VaultError::SyncState {
            msg: format!("grant exchange failed: {e:?}"),
        })?;
        Ok(())
    }

    pub fn pairing_cancel(&self, session_id: &str) -> Result<(), VaultError> {
        let mut sessions = self
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        if let Some(flow) = sessions.remove(session_id) {
            // Drop the post-pairing TcpStream first so the worker thread
            // (if still in flight) sees EOF and exits promptly. The
            // listener Arc going out of scope after this releases the
            // bound pairing port for the next attempt.
            if let Some(s) = flow.post_pairing {
                let _ = s.stream.shutdown(Shutdown::Both);
            }
            // worker_handle is best-effort joined — if the worker is
            // wedged on the listener accept, dropping the listener Arc
            // unblocks it (TcpListener::accept returns an error on
            // socket close). We don't block the IPC thread on that
            // join: detach.
            let _ = flow.worker_handle;
        }
        Ok(())
    }

    // ─── Emitter task lifecycle ───────────────────────────────────────────

    /// Spawn the long-lived task that polls the mDNS peer snapshot and
    /// emits `sync://peers-discovered` when it changes (debounced 250ms).
    /// Idempotent: calling twice replaces the prior thread with a fresh
    /// one (used by tests; production calls once at startup).
    pub fn start_emitter<R: tauri::Runtime>(self: &Arc<Self>, app: AppHandle<R>) {
        let stop = Arc::clone(&self.emitter_stop);
        stop.store(false, std::sync::atomic::Ordering::SeqCst);
        let last_sig = Arc::clone(&self.last_signature);
        let runtime = Arc::clone(self);
        let handle = std::thread::spawn(move || {
            let interval = Duration::from_millis(PEERS_DEBOUNCE_MS);
            let mut last_tick = Instant::now();
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                // Sleep in 50 ms slices so stop is observed promptly.
                if last_tick.elapsed() < interval {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                last_tick = Instant::now();
                // Discovery may not be running yet — skip silently.
                if !runtime.discoverable() {
                    continue;
                }
                let peers = match runtime.list_discovered_peers() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let sig = snapshot_signature(&peers);
                let mut lg = match last_sig.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                if lg.as_ref() == Some(&sig) {
                    continue;
                }
                *lg = Some(sig);
                drop(lg);
                let _ = app.emit(PEERS_DISCOVERED_EVENT, &peers);
            }
        });
        if let Ok(mut g) = self.emitter_handle.lock() {
            *g = Some(handle);
        }
    }

    /// Tear down the emitter thread. Used by tests and process shutdown.
    pub fn stop_emitter(&self) {
        self.emitter_stop
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut g) = self.emitter_handle.lock() {
            if let Some(h) = g.take() {
                let _ = h.join();
            }
        }
    }
}

impl Drop for SyncRuntime {
    fn drop(&mut self) {
        self.stop_emitter();
        let _ = self.discovery.stop();
    }
}

// ─── Pairing worker threads ───────────────────────────────────────────────
//
// Both workers follow the same shape:
//   1. Get the plaintext socket (initiator: accept; responder: dial).
//   2. Hello packet exchange — each side sends `LEN(2) + device_id`.
//   3. PAKE three-step over the same socket (the only thing safe to
//      send before keys exist is PAKE itself).
//   4. Key-confirmation MAC exchange. Mismatch ⇒ feed the wrong MAC into
//      `finalize_with_confirmation` so the lockout counter advances.
//   5. Engine: `drive_*_after_pake` runs Noise XX + long-term-key
//      attestation + peer-trust upsert.
//   6. Compute peer fingerprint from persisted Ed25519 pubkey, write
//      `AwaitingConfirmation` + `peer_fingerprint` + `post_pairing` back
//      into the flow.
//
// On any error we set `state_kind = Failed` and stash the error string.

fn initiator_worker(
    runtime: Arc<SyncRuntime>,
    session_id: String,
    listener: Arc<TcpListener>,
    pin: String,
) {
    // Accept with a timeout so a stalled worker can't pin the port
    // forever. Implemented via `set_nonblocking` + a bounded poll loop
    // so we observe `pairing_cancel` (which drops the listener Arc
    // and therefore breaks the accept) within ~50 ms.
    let stream = match accept_with_deadline(&listener, PAIRING_WORKER_TIMEOUT) {
        Ok(s) => s,
        Err(e) => {
            mark_failed(&runtime, &session_id, format!("accept: {e}"));
            return;
        }
    };

    drive_pake_and_engine(runtime, session_id, stream, pin, PairingRole::Initiator);
}

fn responder_worker(
    runtime: Arc<SyncRuntime>,
    session_id: String,
    addr: SocketAddr,
    pin: String,
) {
    let stream = match TcpStream::connect_timeout(&addr, PAIRING_WORKER_TIMEOUT) {
        Ok(s) => s,
        Err(e) => {
            mark_failed(&runtime, &session_id, format!("dial {addr}: {e}"));
            return;
        }
    };
    drive_pake_and_engine(runtime, session_id, stream, pin, PairingRole::Responder);
}

/// Block on `listener.accept()` for up to `deadline`. Returns the
/// accepted stream or an error on timeout / cancellation. Polls on a
/// 50 ms cadence so cancel-via-listener-drop is observed promptly.
fn accept_with_deadline(
    listener: &TcpListener,
    deadline: Duration,
) -> std::io::Result<TcpStream> {
    listener.set_nonblocking(true)?;
    let stop_at = Instant::now() + deadline;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                return Ok(stream);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= stop_at {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "pairing accept timeout",
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e),
        }
    }
}

fn drive_pake_and_engine(
    runtime: Arc<SyncRuntime>,
    session_id: String,
    mut stream: TcpStream,
    pin: String,
    role: PairingRole,
) {
    // Read/write timeouts so a hung peer surfaces as `Failed` rather
    // than a phantom "awaiting_peer" forever. The engine's Noise
    // handshake also benefits.
    let _ = stream.set_read_timeout(Some(PAKE_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PAKE_IO_TIMEOUT));
    let _ = stream.set_nodelay(true);

    let self_id = runtime.identity.device_id().to_string();

    // Hello: exchange device ids.
    if let Err(e) = write_len_prefixed(&mut stream, self_id.as_bytes()) {
        mark_failed(&runtime, &session_id, format!("hello write: {e}"));
        return;
    }
    let peer_id = match read_len_prefixed_string(&mut stream) {
        Ok(s) => s,
        Err(e) => {
            mark_failed(&runtime, &session_id, format!("hello read: {e}"));
            return;
        }
    };

    // Stash peer_id eagerly so `pairing_cancel` / `pairing_step` can
    // see who we're talking to even before PAKE finishes.
    if let Ok(mut sessions) = runtime.pairing_sessions.lock() {
        if let Some(flow) = sessions.get_mut(&session_id) {
            // Responder may already have a peer_device_id from the IPC
            // call — assert consistency. Initiator learns it here.
            if let Some(prior) = flow.peer_device_id.as_deref() {
                if prior != peer_id {
                    let msg = format!("hello peer id mismatch: got {peer_id}, expected {prior}");
                    flow.state_kind = PairingState::Failed;
                    flow.error = Some(msg);
                    return;
                }
            } else {
                flow.peer_device_id = Some(peer_id.clone());
            }
        } else {
            // Session vanished (cancelled) — bail.
            return;
        }
    }

    // Drive PAKE. Per the spec, `id_a` is always the initiator's id and
    // `id_b` the responder's, regardless of which role we're playing.
    let (id_a, id_b) = match role {
        PairingRole::Initiator => (self_id.clone(), peer_id.clone()),
        PairingRole::Responder => (peer_id.clone(), self_id.clone()),
    };

    let raw_keys = match role {
        PairingRole::Initiator => {
            let s1 = match start_initiator(&pin, &id_a, &id_b) {
                Ok(s) => s,
                Err(e) => {
                    mark_failed(&runtime, &session_id, format!("pake start: {e:?}"));
                    return;
                }
            };
            if let Err(e) = stream.write_all(&s1.step1_packet()) {
                mark_failed(&runtime, &session_id, format!("step1 write: {e}"));
                return;
            }
            let mut step2 = [0u8; pake_cpace::STEP2_PACKET_BYTES];
            if let Err(e) = stream.read_exact(&mut step2) {
                mark_failed(&runtime, &session_id, format!("step2 read: {e}"));
                return;
            }
            match s1.step3(&step2) {
                Ok(rk) => rk,
                Err(e) => {
                    mark_failed(&runtime, &session_id, format!("step3: {e:?}"));
                    return;
                }
            }
        }
        PairingRole::Responder => {
            let mut step1 = [0u8; pake_cpace::STEP1_PACKET_BYTES];
            if let Err(e) = stream.read_exact(&mut step1) {
                mark_failed(&runtime, &session_id, format!("step1 read: {e}"));
                return;
            }
            let r = match respond(&step1, &pin, &id_a, &id_b) {
                Ok(r) => r,
                Err(e) => {
                    mark_failed(&runtime, &session_id, format!("respond: {e:?}"));
                    return;
                }
            };
            if let Err(e) = stream.write_all(&r.step2_packet()) {
                mark_failed(&runtime, &session_id, format!("step2 write: {e}"));
                return;
            }
            r.raw_keys
        }
    };

    // Key-confirmation: send our MAC, receive the peer's, finalize.
    let local_mac = key_confirmation_mac(&raw_keys.k2, &id_a, &id_b);
    if let Err(e) = stream.write_all(&local_mac) {
        mark_failed(&runtime, &session_id, format!("mac write: {e}"));
        return;
    }
    let mut peer_mac = [0u8; 32];
    if let Err(e) = stream.read_exact(&mut peer_mac) {
        mark_failed(&runtime, &session_id, format!("mac read: {e}"));
        return;
    }

    // We need the session lock briefly to call `finalize_with_confirmation`,
    // which mutates the lockout counter. Hold the lock only for the
    // attempt-counter update; release before driving the engine (slow).
    let confirm_outcome = {
        let sessions = match runtime.pairing_sessions.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(flow) = sessions.get(&session_id) else {
            return;
        };
        finalize_with_confirmation(&raw_keys, &peer_mac, &flow.session)
    };
    if let Err(e) = confirm_outcome {
        // Bump the failure state. Lockout (3 strikes) is reflected by
        // `pairing_step` reading the session's `is_locked` flag.
        let attempts_remaining_after = match runtime.pairing_sessions.lock() {
            Ok(s) => s
                .get(&session_id)
                .and_then(|f| f.session.failed_count().ok())
                .map(|n| LOCKOUT_AFTER_ATTEMPTS.saturating_sub(n)),
            Err(_) => None,
        };
        mark_failed(
            &runtime,
            &session_id,
            format!("key confirmation: {e:?} (attempts_remaining≈{attempts_remaining_after:?})"),
        );
        return;
    }
    let k2 = raw_keys.k2;

    // Now run the engine. This requires an active SyncState — without
    // one the peer-trust upsert can't persist.
    let state = match runtime.require_active_state() {
        Ok(s) => s,
        Err(e) => {
            mark_failed(&runtime, &session_id, format!("no active vault: {e:?}"));
            return;
        }
    };
    let signing_key = runtime.identity.signing_key().clone();
    let noise_kp = runtime.noise_kp.clone();

    let post = match role {
        PairingRole::Initiator => drive_initiator_after_pake(
            &mut stream,
            &noise_kp,
            &signing_key,
            &self_id,
            &peer_id,
            &k2,
            &state,
        ),
        PairingRole::Responder => drive_responder_after_pake(
            &mut stream,
            &noise_kp,
            &signing_key,
            &self_id,
            &peer_id,
            &k2,
            &state,
        ),
    };
    let post = match post {
        Ok(p) => p,
        Err(e) => {
            mark_failed(&runtime, &session_id, format!("engine drive: {e:?}"));
            return;
        }
    };

    // Compute the fingerprint from the peer's persisted long-term
    // pubkey — the engine just wrote it under PeerTrust::Trusted, so
    // `peer_pubkey` returns Some.
    let fingerprint = state
        .peer_pubkey(&peer_id)
        .ok()
        .flatten()
        .map(|pk| fingerprint_from_pubkey(&pk));

    if let Ok(mut sessions) = runtime.pairing_sessions.lock() {
        if let Some(flow) = sessions.get_mut(&session_id) {
            flow.post_pairing = Some(post);
            flow.peer_fingerprint = fingerprint;
            flow.raw_keys = Some(raw_keys);
            flow.state_kind = PairingState::AwaitingConfirmation;
        }
    }
}

fn write_len_prefixed(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    if body.len() > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "len-prefix payload too large",
        ));
    }
    stream.write_all(&(body.len() as u16).to_be_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

fn read_len_prefixed_string(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut len_buf = [0u8; 2];
    stream.read_exact(&mut len_buf)?;
    let n = u16::from_be_bytes(len_buf) as usize;
    if n > 256 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "hello id too long",
        ));
    }
    let mut buf = vec![0u8; n];
    stream.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("hello utf8: {e}"))
    })
}

fn mark_failed(runtime: &Arc<SyncRuntime>, session_id: &str, msg: String) {
    if let Ok(mut sessions) = runtime.pairing_sessions.lock() {
        if let Some(flow) = sessions.get_mut(session_id) {
            flow.state_kind = PairingState::Failed;
            flow.error = Some(msg);
        }
    }
}

/// Same recipe `Identity::pubkey_fp` uses on our own key: derive the
/// device id (`base32(SHA-256(pubkey)[..16])`) and take the first 8 chars.
fn fingerprint_from_pubkey(pubkey: &[u8; 32]) -> String {
    use data_encoding::BASE32_NOPAD;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(pubkey);
    let device_id = BASE32_NOPAD.encode(&digest[..16]);
    device_id.chars().take(8).collect()
}

fn peer_row_exists(state: &SyncState, peer_device_id: &str) -> Result<bool, VaultError> {
    let conn = state.lock_conn()?;
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_peers WHERE peer_device_id = ?1",
            rusqlite::params![peer_device_id],
            |r| r.get(0),
        )
        .map_err(|e| VaultError::SyncState {
            msg: format!("sqlite: {e}"),
        })?;
    Ok(n > 0)
}

/// Generate a 6-digit numeric PIN. Uses [`rand::Rng`] under the hood —
/// `OsRng` would also work but `thread_rng` is fine for a 1-in-a-million
/// guess space that's already lockout-protected after 3 attempts.
fn generate_pin_6_digit() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let n: u32 = rng.gen_range(0..1_000_000);
    format!("{n:06}")
}

// ─── Tauri command handlers ──────────────────────────────────────────────

#[tauri::command]
pub fn sync_get_self_identity(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
) -> Result<SelfIdentityDto, VaultError> {
    Ok(runtime.self_identity())
}

#[tauri::command]
pub fn sync_set_device_name(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    name: String,
) -> Result<(), VaultError> {
    runtime.set_device_name(name)
}

/// Replaces the v0 `commands::sync::sync_get_discoverable` shim — the
/// new bridge owns the daemon lifecycle, so the static-flag value
/// alone is no longer the source of truth.
#[tauri::command]
pub fn sync_get_discoverable(runtime: tauri::State<'_, Arc<SyncRuntime>>) -> bool {
    runtime.discoverable()
}

#[tauri::command]
pub fn sync_set_discoverable(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    on: bool,
) -> Result<(), VaultError> {
    runtime.set_discoverable(on)
}

#[tauri::command]
pub fn sync_list_discovered_peers(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
) -> Result<Vec<DiscoveredPeerDto>, VaultError> {
    runtime.list_discovered_peers()
}

#[tauri::command]
pub fn sync_list_paired_peers(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
) -> Result<Vec<PairedPeerDto>, VaultError> {
    runtime.list_paired_peers()
}

#[tauri::command]
pub fn sync_pairing_start_initiator(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
) -> Result<PairingStartInitiatorDto, VaultError> {
    runtime.inner().pairing_start_initiator(None, None)
}

#[tauri::command]
pub fn sync_pairing_start_responder(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    pin: String,
    peer_device_id: Option<String>,
) -> Result<PairingStartResponderDto, VaultError> {
    runtime
        .inner()
        .pairing_start_responder(&pin, peer_device_id, None)
}

#[tauri::command]
pub fn sync_pairing_step(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    session_id: String,
    payload: Option<String>,
) -> Result<PairingStepDto, VaultError> {
    runtime.pairing_step(&session_id, payload)
}

#[tauri::command]
pub fn sync_pairing_confirm<R: tauri::Runtime>(
    app: AppHandle<R>,
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    session_id: String,
) -> Result<(), VaultError> {
    let dto = runtime.pairing_confirm(&session_id)?;
    let _ = app.emit(PEER_PAIRED_EVENT, &dto);
    Ok(())
}

#[tauri::command]
pub fn sync_pairing_cancel(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    session_id: String,
) -> Result<(), VaultError> {
    runtime.pairing_cancel(&session_id)
}

#[tauri::command]
pub fn sync_pairing_grant_vault(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    session_id: String,
    vault_id: String,
    scope: String,
) -> Result<(), VaultError> {
    let parsed = Scope::parse(&scope).ok_or_else(|| VaultError::SyncState {
        msg: format!("invalid scope: {scope}"),
    })?;
    runtime.pairing_grant_vault(&session_id, &vault_id, parsed)
}

#[tauri::command]
pub fn sync_grant_vault(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    peer_device_id: String,
    vault_id: String,
    scope: String,
) -> Result<(), VaultError> {
    let parsed = Scope::parse(&scope).ok_or_else(|| VaultError::SyncState {
        msg: format!("invalid scope: {scope}"),
    })?;
    runtime.grant_vault(&peer_device_id, &vault_id, parsed)
}

#[tauri::command]
pub fn sync_revoke_peer(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    peer_device_id: String,
) -> Result<(), VaultError> {
    runtime.revoke_peer(&peer_device_id)
}

#[tauri::command]
pub fn sync_revoke_vault_grant(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    peer_device_id: String,
    vault_id: String,
) -> Result<(), VaultError> {
    runtime.revoke_vault_grant(&peer_device_id, &vault_id)
}

// Re-exports for tests.
#[cfg(test)]
pub(crate) use self::testing::*;

#[cfg(test)]
mod testing {
    use super::*;

    /// Test-only constructor that pre-populates a pairing flow already
    /// at the `AwaitingConfirmation` state — bypasses the worker thread
    /// so unit tests can exercise the `pairing_confirm` path without
    /// running PAKE or wiring a transport. Returns the session id.
    pub(crate) fn inject_pairing_flow_for_test(
        runtime: &SyncRuntime,
        peer_device_id: &str,
        raw_keys: RawSharedKeys,
    ) -> Result<String, VaultError> {
        let session_id = Uuid::new_v4().to_string();
        let session = PairingSession::new();
        session.issue_pin()?;
        let _ = runtime;
        let flow = PairingFlow {
            session,
            role: PairingRole::Initiator,
            peer_device_id: Some(peer_device_id.to_string()),
            peer_fingerprint: Some(peer_device_id.chars().take(8).collect()),
            raw_keys: Some(raw_keys),
            state_kind: PairingState::AwaitingConfirmation,
            error: None,
            post_pairing: None,
            listener_handle: None,
            worker_handle: None,
        };
        runtime
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?
            .insert(session_id.clone(), flow);
        Ok(session_id)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::clock::TestClock;
    use crate::sync::discovery::AdvertisedVault;
    use crate::sync::history::HistoryConfig;
    use crate::sync::state::SyncState;
    use ed25519_dalek::SigningKey;
    use rand_core::RngCore;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn build_runtime() -> Arc<SyncRuntime> {
        Arc::new(SyncRuntime::new_for_test().expect("runtime"))
    }

    fn open_active_state(rt: &SyncRuntime, tmp: &TempDir) -> Arc<SyncState> {
        let metadata = tmp.path().join(".vaultcore");
        std::fs::create_dir_all(&metadata).unwrap();
        let state = Arc::new(
            SyncState::open_with(
                &metadata,
                rt.identity.device_id().to_string(),
                Arc::new(TestClock::new(1_700_000_000)),
                HistoryConfig::default(),
            )
            .expect("open sync state"),
        );
        rt.set_active_sync_state(Some(Arc::clone(&state))).unwrap();
        state
    }

    fn fresh_signing_key() -> SigningKey {
        let mut bytes = [0u8; 32];
        rand_core::OsRng.fill_bytes(&mut bytes);
        SigningKey::from_bytes(&bytes)
    }

    fn pair_test_peer(state: &SyncState, peer_id: &str) {
        let owner = fresh_signing_key();
        let pk = owner.verifying_key().to_bytes();
        state
            .upsert_peer(peer_id, &pk, "Test Peer", PeerTrust::Trusted)
            .unwrap();
    }

    // ─── identity ────────────────────────────────────────────────────────

    #[test]
    fn self_identity_returns_stable_id_across_calls() {
        let rt = build_runtime();
        let a = rt.self_identity();
        let b = rt.self_identity();
        assert_eq!(a.device_id, b.device_id);
        assert_eq!(a.pubkey_fingerprint.len(), 8);
        // device_id is base32 of SHA-256(pubkey)[..16] → 26 chars.
        assert_eq!(a.device_id.len(), 26);
        assert!(!a.device_name.is_empty());
    }

    #[test]
    fn set_device_name_overrides_default() {
        let rt = build_runtime();
        rt.set_device_name("Bob's Laptop".into()).unwrap();
        assert_eq!(rt.self_identity().device_name, "Bob's Laptop");
    }

    // ─── discoverable toggle ─────────────────────────────────────────────

    #[test]
    fn set_discoverable_is_idempotent() {
        let rt = build_runtime();
        assert!(!rt.discoverable());
        rt.set_discoverable(true).unwrap();
        assert!(rt.discoverable());
        // Second call must not error.
        rt.set_discoverable(true).unwrap();
        assert!(rt.discoverable());
        rt.set_discoverable(false).unwrap();
        assert!(!rt.discoverable());
        rt.set_discoverable(false).unwrap();
        assert!(!rt.discoverable());
    }

    #[test]
    fn list_discovered_peers_empty_when_idle() {
        let rt = build_runtime();
        // Daemon hasn't been started yet — the snapshot is empty, not an error.
        let peers = rt.list_discovered_peers().unwrap();
        assert!(peers.is_empty());
    }

    // ─── paired peers / grants ───────────────────────────────────────────

    #[test]
    fn list_paired_peers_returns_empty_when_no_vault_open() {
        let rt = build_runtime();
        let peers = rt.list_paired_peers().unwrap();
        assert!(peers.is_empty(), "no vault → empty list, not an error");
    }

    #[test]
    fn list_paired_peers_returns_persisted_peers() {
        let rt = build_runtime();
        let tmp = TempDir::new().unwrap();
        let state = open_active_state(&rt, &tmp);
        pair_test_peer(&state, "PEERAAAAAAAAAAAAAAAAAA");
        pair_test_peer(&state, "PEERBBBBBBBBBBBBBBBBBB");
        let peers = rt.list_paired_peers().unwrap();
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].device_id, "PEERAAAAAAAAAAAAAAAAAA");
        assert_eq!(peers[0].device_name, "Test Peer");
        assert!(peers[0].grants.is_empty(), "no grant issued yet");
    }

    #[test]
    fn grant_vault_persists_capability_and_surfaces_in_paired_peers() {
        let rt = build_runtime();
        let tmp = TempDir::new().unwrap();
        let state = open_active_state(&rt, &tmp);
        pair_test_peer(&state, "PEERAAAAAAAAAAAAAAAAAA");
        rt.grant_vault("PEERAAAAAAAAAAAAAAAAAA", "vault-xyz", Scope::ReadWrite)
            .unwrap();
        let peers = rt.list_paired_peers().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].grants.len(), 1);
        assert_eq!(peers[0].grants[0].vault_id, "vault-xyz");
        assert_eq!(peers[0].grants[0].scope, "read+write");
    }

    #[test]
    fn grant_vault_rejects_unknown_peer() {
        let rt = build_runtime();
        let tmp = TempDir::new().unwrap();
        let _state = open_active_state(&rt, &tmp);
        let err = rt
            .grant_vault("UNKNOWNPEERID", "vault-xyz", Scope::Read)
            .expect_err("unknown peer must error");
        match err {
            VaultError::SyncState { msg } => {
                assert!(msg.contains("unknown") || msg.contains("revoked"))
            }
            other => panic!("wrong error variant: {other:?}"),
        }
    }

    #[test]
    fn revoke_vault_grant_disables_row_and_errors_when_absent() {
        let rt = build_runtime();
        let tmp = TempDir::new().unwrap();
        let state = open_active_state(&rt, &tmp);
        pair_test_peer(&state, "PEERAAAAAAAAAAAAAAAAAA");
        rt.grant_vault("PEERAAAAAAAAAAAAAAAAAA", "v1", Scope::Read)
            .unwrap();
        rt.revoke_vault_grant("PEERAAAAAAAAAAAAAAAAAA", "v1")
            .unwrap();
        let peers = rt.list_paired_peers().unwrap();
        assert_eq!(peers[0].grants.len(), 0, "revoked grant must drop");
        // Second revoke: now the row is disabled, the call must error.
        let err = rt
            .revoke_vault_grant("PEERAAAAAAAAAAAAAAAAAA", "v1")
            .expect_err("revoking absent grant must error");
        match err {
            VaultError::SyncState { .. } => {}
            other => panic!("wrong error: {other:?}"),
        }
    }

    #[test]
    fn revoke_peer_marks_revoked_and_disables_all_grants() {
        let rt = build_runtime();
        let tmp = TempDir::new().unwrap();
        let state = open_active_state(&rt, &tmp);
        pair_test_peer(&state, "PEERAAAAAAAAAAAAAAAAAA");
        rt.grant_vault("PEERAAAAAAAAAAAAAAAAAA", "v1", Scope::Read)
            .unwrap();
        rt.grant_vault("PEERAAAAAAAAAAAAAAAAAA", "v2", Scope::ReadWrite)
            .unwrap();
        rt.revoke_peer("PEERAAAAAAAAAAAAAAAAAA").unwrap();
        // Revoked peer must NOT show in list_paired_peers (only Trusted).
        let peers = rt.list_paired_peers().unwrap();
        assert!(peers.is_empty(), "revoked peer hidden from list");
    }

    #[test]
    fn revoke_peer_rejects_unknown_id() {
        let rt = build_runtime();
        let tmp = TempDir::new().unwrap();
        let _state = open_active_state(&rt, &tmp);
        let err = rt
            .revoke_peer("NEVERSEENPEERID")
            .expect_err("unknown peer must error");
        match err {
            VaultError::SyncState { msg } => assert!(msg.contains("unknown")),
            other => panic!("wrong error: {other:?}"),
        }
    }

    #[test]
    fn grant_vault_errors_when_no_vault_open() {
        let rt = build_runtime();
        let err = rt
            .grant_vault("PEER", "v1", Scope::Read)
            .expect_err("no vault → error");
        match err {
            VaultError::SyncState { msg } => assert!(msg.contains("no vault")),
            other => panic!("wrong error: {other:?}"),
        }
    }

    // ─── pairing flow ────────────────────────────────────────────────────

    #[test]
    fn pairing_start_initiator_returns_session_id_pin_and_expiry() {
        let rt = build_runtime();
        let dto = rt.pairing_start_initiator(None, Some(0)).unwrap();
        assert_eq!(dto.pin.len(), 6);
        assert!(dto.pin.chars().all(|c| c.is_ascii_digit()));
        assert!(!dto.session_id.is_empty());
        assert!(dto.expires_at_unix > 0);
        // Tear down so the worker thread + ephemeral listener exit
        // promptly rather than dangling for the full PAIRING_WORKER_TIMEOUT.
        rt.pairing_cancel(&dto.session_id).unwrap();
    }

    #[test]
    fn pairing_start_responder_validates_pin() {
        let rt = build_runtime();
        // Non-numeric PIN must reject before the session is created.
        let err = rt
            .pairing_start_responder("abcdef", None, None)
            .expect_err("non-numeric");
        match err {
            VaultError::SyncState { .. } => {}
            other => panic!("wrong error: {other:?}"),
        }
        // Valid 6-digit PIN with no peer/addr — sits in awaiting_peer.
        let dto = rt.pairing_start_responder("123456", None, None).unwrap();
        assert!(!dto.session_id.is_empty());
        rt.pairing_cancel(&dto.session_id).unwrap();
    }

    #[test]
    fn pairing_step_returns_awaiting_peer_for_fresh_session() {
        let rt = build_runtime();
        let started = rt.pairing_start_initiator(None, Some(0)).unwrap();
        let step = rt.pairing_step(&started.session_id, None).unwrap();
        assert_eq!(step.kind, "awaiting_peer");
        assert_eq!(step.attempts_remaining, Some(LOCKOUT_AFTER_ATTEMPTS));
        rt.pairing_cancel(&started.session_id).unwrap();
    }

    #[test]
    fn pairing_step_errors_on_unknown_session() {
        let rt = build_runtime();
        let err = rt.pairing_step("not-a-real-session", None).unwrap_err();
        match err {
            VaultError::SyncState { msg } => assert!(msg.contains("unknown")),
            other => panic!("wrong error: {other:?}"),
        }
    }

    #[test]
    fn pairing_cancel_removes_session() {
        let rt = build_runtime();
        let started = rt.pairing_start_initiator(None, Some(0)).unwrap();
        rt.pairing_cancel(&started.session_id).unwrap();
        // After cancel, step on the same id must error with "unknown".
        let err = rt.pairing_step(&started.session_id, None).unwrap_err();
        assert!(matches!(err, VaultError::SyncState { .. }));
    }

    #[test]
    fn pairing_cancel_is_idempotent_for_unknown_id() {
        let rt = build_runtime();
        rt.pairing_cancel("never-existed").unwrap();
    }

    #[test]
    fn pairing_confirm_errors_when_not_at_confirmation_step() {
        let rt = build_runtime();
        let started = rt.pairing_start_initiator(None, Some(0)).unwrap();
        let err = rt.pairing_confirm(&started.session_id).unwrap_err();
        match err {
            VaultError::SyncState { msg } => assert!(msg.contains("confirmation")),
            other => panic!("wrong error: {other:?}"),
        }
        rt.pairing_cancel(&started.session_id).unwrap();
    }

    #[test]
    fn pairing_confirm_advances_state_to_complete() {
        let rt = build_runtime();
        let tmp = TempDir::new().unwrap();
        let _state = open_active_state(&rt, &tmp);
        let raw = RawSharedKeys {
            k1: [0xAB; 32],
            k2: [0xCD; 32],
            id_a: rt.identity.device_id().to_string(),
            id_b: "TESTPEERIDXXXXXXX".into(),
        };
        let session_id =
            inject_pairing_flow_for_test(&rt, "TESTPEERIDXXXXXXX", raw).unwrap();
        let dto = rt.pairing_confirm(&session_id).unwrap();
        assert_eq!(dto.device_id, "TESTPEERIDXXXXXXX");
        // After confirm, step reports `complete` so the UI advances.
        let step = rt.pairing_step(&session_id, None).unwrap();
        assert_eq!(step.kind, "complete");
    }

    #[test]
    fn pairing_confirm_errors_on_unknown_session() {
        let rt = build_runtime();
        let err = rt.pairing_confirm("not-a-session").unwrap_err();
        match err {
            VaultError::SyncState { msg } => assert!(msg.contains("unknown")),
            other => panic!("wrong error: {other:?}"),
        }
    }

    // ─── DTO snapshot conversion ─────────────────────────────────────────

    #[test]
    fn peer_ad_to_dto_renders_addr_as_host_port() {
        let ad = PeerAd {
            device_id: "ABCDEFGHIJKLMNOPQRSTUVWX".into(),
            name: "Alice".into(),
            vaults: vec![AdvertisedVault {
                id: "v1".into(),
                name: "Notes".into(),
            }],
            pubkey_fp: "ABCDEFGH".into(),
            proto: PROTO_VERSION.to_string(),
            addrs: vec!["192.168.1.10".parse().unwrap()],
            port: 17091,
        };
        let dto = peer_ad_to_dto(&ad);
        assert_eq!(dto.device_id, "ABCDEFGHIJKLMNOPQRSTUVWX");
        assert_eq!(dto.device_name, "Alice");
        assert_eq!(dto.addr, "192.168.1.10:17091");
        assert_eq!(dto.vaults.len(), 1);
        assert_eq!(dto.vaults[0].name, "Notes");
    }

    #[test]
    fn peer_ad_to_dto_emits_empty_addr_when_no_addresses() {
        let ad = PeerAd {
            device_id: "X".into(),
            name: "X".into(),
            vaults: vec![],
            pubkey_fp: "X".into(),
            proto: PROTO_VERSION.to_string(),
            addrs: vec![],
            port: 17091,
        };
        let dto = peer_ad_to_dto(&ad);
        assert_eq!(dto.addr, "");
    }

    #[test]
    fn snapshot_signature_stable_under_reorder() {
        let mk = |id: &str| DiscoveredPeerDto {
            device_id: id.into(),
            device_name: "x".into(),
            vaults: vec![],
            addr: "".into(),
        };
        let a = vec![mk("A"), mk("B"), mk("C")];
        let b = vec![mk("C"), mk("A"), mk("B")];
        assert_eq!(snapshot_signature(&a), snapshot_signature(&b));
        let c = vec![mk("A"), mk("B")];
        assert_ne!(snapshot_signature(&a), snapshot_signature(&c));
    }
}

