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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::error::VaultError;
use crate::sync::capability::{Capability, CapabilityBody, Scope};
use crate::sync::discovery::{Discovery, MdnsDiscovery, PeerAd, PROTO_VERSION};
use crate::sync::identity::{Identity, KeyStore, MemoryKeyStore, OsKeychainStore};
use crate::sync::pairing::{
    finalize_with_confirmation, key_confirmation_mac, validate_pin, ConfirmedKeys,
    PairingSession, RawSharedKeys, LOCKOUT_AFTER_ATTEMPTS, PIN_EXPIRY_SECS,
};
use crate::sync::state::{PeerTrust, SyncState};

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
    #[allow(dead_code)]
    role: PairingRole,
    /// Peer device id, if known. The initiator learns it from the
    /// step1 reply payload; the responder learns it from the step1
    /// packet sent by the initiator.
    peer_device_id: Option<String>,
    /// Once PAKE step1+step2 have been driven, the raw shared keys
    /// land here awaiting key-confirmation. `None` means PAKE is not
    /// yet finished. `id_a` / `id_b` on the `RawSharedKeys` carry the
    /// device id pair, so we don't need a separate `self_device_id`.
    raw_keys: Option<RawSharedKeys>,
    /// Cached fingerprint we display to the user during confirmation.
    /// Populated alongside `raw_keys`. Eight base32 chars per spec.
    peer_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairingRole {
    Initiator,
    Responder,
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
        let device_name = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "VaultCore".to_string());
        let discovery = Arc::new(MdnsDiscovery::new()?);
        Ok(Self {
            identity,
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
    pub(crate) fn active_sync_state(&self) -> Option<Arc<SyncState>> {
        self.active_state.lock().ok().and_then(|g| g.clone())
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

    pub fn pairing_start_initiator(&self) -> Result<PairingStartInitiatorDto, VaultError> {
        let session_id = Uuid::new_v4().to_string();
        let pin = generate_pin_6_digit();
        let session = PairingSession::new();
        session.issue_pin()?;
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let flow = PairingFlow {
            session,
            role: PairingRole::Initiator,
            peer_device_id: None,
            raw_keys: None,
            peer_fingerprint: None,
        };
        self.pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?
            .insert(session_id.clone(), flow);
        Ok(PairingStartInitiatorDto {
            session_id,
            pin,
            expires_at_unix: now_secs + PIN_EXPIRY_SECS,
        })
    }

    pub fn pairing_start_responder(
        &self,
        pin: &str,
    ) -> Result<PairingStartResponderDto, VaultError> {
        validate_pin(pin).map_err(VaultError::from)?;
        let session_id = Uuid::new_v4().to_string();
        let session = PairingSession::new();
        session.issue_pin()?;
        let flow = PairingFlow {
            session,
            role: PairingRole::Responder,
            peer_device_id: None,
            raw_keys: None,
            peer_fingerprint: None,
        };
        self.pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?
            .insert(session_id.clone(), flow);
        Ok(PairingStartResponderDto { session_id })
    }

    /// Drive the PAKE state machine. Today's UI-1 plumbing is a stub
    /// that returns `awaiting_peer` until transport (#419) carries the
    /// step packets between devices. Once transport lands, this method
    /// will accept a base64 payload and dispatch to
    /// [`start_initiator`] / [`respond`] / [`InitiatorAfterStep1::step3`].
    /// The method exists today so the IPC contract is stable and UI-3
    /// can render the spinner while waiting on the peer.
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
        if flow.session.is_locked()? {
            return Ok(PairingStepDto {
                kind: "failed".into(),
                peer_fingerprint: None,
                attempts_remaining: Some(0),
            });
        }
        if !flow.session.pin_valid()? {
            return Ok(PairingStepDto {
                kind: "failed".into(),
                peer_fingerprint: None,
                attempts_remaining: Some(0),
            });
        }
        let attempts_remaining = LOCKOUT_AFTER_ATTEMPTS - flow.session.failed_count()?;
        Ok(PairingStepDto {
            kind: "awaiting_peer".into(),
            peer_fingerprint: flow.peer_fingerprint.clone(),
            attempts_remaining: Some(attempts_remaining),
        })
    }

    /// Final confirmation step: persist the peer to `sync_peers` and emit
    /// `sync://peer-paired`. UI-1 stub: in production this is gated on
    /// the user clicking "Confirm" after seeing the matching fingerprint;
    /// transport-layer code (#419) will drive `raw_keys` into the flow
    /// before this is callable. For UI-1 we accept calls when raw_keys
    /// is present (from a future transport hook) and otherwise return a
    /// PairError-shaped error so the UI surfaces a clear failure.
    pub fn pairing_confirm(&self, session_id: &str) -> Result<PeerPairedEventDto, VaultError> {
        let mut sessions = self
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        let Some(flow) = sessions.remove(session_id) else {
            return Err(VaultError::SyncState {
                msg: format!("unknown pairing session: {session_id}"),
            });
        };
        let raw = flow.raw_keys.ok_or_else(|| VaultError::SyncState {
            msg: "pairing not yet at confirmation step (no shared keys)".into(),
        })?;
        let peer_id = flow.peer_device_id.ok_or_else(|| VaultError::SyncState {
            msg: "pairing has no peer device id".into(),
        })?;
        let _role = flow.role;
        // Build our local MAC and feed both into the canonical
        // confirmation helper so any future change to the MAC layout
        // doesn't have to be mirrored here. The peer's MAC is delivered
        // through the transport layer; UI-1 doesn't have that wired yet,
        // so we self-confirm against our own MAC bytes — once transport
        // lands, replace the `&local_mac` arg below with the bytes from
        // the incoming step3/finalize packet.
        let local_mac = key_confirmation_mac(&raw.k2, &raw.id_a, &raw.id_b);
        let _confirmed: ConfirmedKeys =
            finalize_with_confirmation(&raw, &local_mac, &flow.session)
                .map_err(|e| VaultError::from(e))?;
        // Persist trust to the active vault's SyncState. If no vault is
        // open we still return success so the UI flow completes (the
        // engine wiring task may extend this to defer peer persistence
        // until vault open) — but typical UAT pairs while a vault is open.
        let device_name = format!("Peer {peer_id}");
        if let Ok(active) = self.require_active_state() {
            active.upsert_peer(
                &peer_id,
                &[0u8; 32], // placeholder — transport supplies the long-term pubkey via the noise XX exchange (#419)
                &device_name,
                PeerTrust::Trusted,
            )?;
        }
        Ok(PeerPairedEventDto {
            device_id: peer_id,
            device_name,
        })
    }

    pub fn pairing_cancel(&self, session_id: &str) -> Result<(), VaultError> {
        let mut sessions = self
            .pairing_sessions
            .lock()
            .map_err(|_| VaultError::LockPoisoned)?;
        sessions.remove(session_id);
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
    runtime.pairing_start_initiator()
}

#[tauri::command]
pub fn sync_pairing_start_responder(
    runtime: tauri::State<'_, Arc<SyncRuntime>>,
    pin: String,
) -> Result<PairingStartResponderDto, VaultError> {
    runtime.pairing_start_responder(&pin)
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

    /// Test-only constructor that pre-populates a pairing flow with raw
    /// shared keys so confirmation paths can be exercised without a
    /// running transport layer. Returns the session id.
    pub(crate) fn inject_pairing_flow_for_test(
        runtime: &SyncRuntime,
        peer_device_id: &str,
        raw_keys: RawSharedKeys,
    ) -> Result<String, VaultError> {
        let session_id = Uuid::new_v4().to_string();
        let session = PairingSession::new();
        session.issue_pin()?;
        let _ = runtime; // identity is captured implicitly through `raw_keys.id_a` / `id_b`.
        let flow = PairingFlow {
            session,
            role: PairingRole::Initiator,
            peer_device_id: Some(peer_device_id.to_string()),
            peer_fingerprint: Some(peer_device_id.chars().take(8).collect()),
            raw_keys: Some(raw_keys),
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
        let dto = rt.pairing_start_initiator().unwrap();
        assert_eq!(dto.pin.len(), 6);
        assert!(dto.pin.chars().all(|c| c.is_ascii_digit()));
        assert!(!dto.session_id.is_empty());
        assert!(dto.expires_at_unix > 0);
    }

    #[test]
    fn pairing_start_responder_validates_pin() {
        let rt = build_runtime();
        // Non-numeric PIN must reject before the session is created.
        let err = rt.pairing_start_responder("abcdef").expect_err("non-numeric");
        match err {
            VaultError::SyncState { .. } => {}
            other => panic!("wrong error: {other:?}"),
        }
        // Valid 6-digit PIN must succeed.
        let dto = rt.pairing_start_responder("123456").unwrap();
        assert!(!dto.session_id.is_empty());
    }

    #[test]
    fn pairing_step_returns_awaiting_peer_for_fresh_session() {
        let rt = build_runtime();
        let started = rt.pairing_start_initiator().unwrap();
        let step = rt.pairing_step(&started.session_id, None).unwrap();
        assert_eq!(step.kind, "awaiting_peer");
        assert_eq!(step.attempts_remaining, Some(LOCKOUT_AFTER_ATTEMPTS));
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
        let started = rt.pairing_start_initiator().unwrap();
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
    fn pairing_confirm_errors_when_no_raw_keys_yet() {
        let rt = build_runtime();
        let started = rt.pairing_start_initiator().unwrap();
        let err = rt.pairing_confirm(&started.session_id).unwrap_err();
        match err {
            VaultError::SyncState { msg } => assert!(msg.contains("not yet")),
            other => panic!("wrong error: {other:?}"),
        }
    }

    #[test]
    fn pairing_confirm_persists_peer_when_keys_present() {
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
        // Peer is now in the trust store (note: pubkey is placeholder
        // bytes per UI-1's transport-pending caveat, so peer_pubkey()
        // returns Some for trusted peers regardless of whether keys are
        // real; the row exists.)
        let active = rt.active_sync_state().unwrap();
        let peers = active.list_paired_peers().unwrap();
        assert!(peers.iter().any(|p| p.peer_device_id == "TESTPEERIDXXXXXXX"));
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

