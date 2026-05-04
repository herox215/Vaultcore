//! End-to-end LAN sync acceptance test (epic #73, ticket #6).
//!
//! Spins up two in-process `Device` instances on `127.0.0.1` with two
//! distinct vault directories and validates the full happy path of the
//! v1 sync stack: discovery (mDNS, cfg-gated), PAKE pairing with key
//! confirmation, capability grant exchange, change-event propagation,
//! conflict-copy on concurrent edits, tombstone-driven deletion, and
//! Merkle catch-up after one side has been offline.
//!
//! Synchronization across the two devices is done by polling helpers
//! (`wait_until`) — no `std::thread::sleep` is used to wait for sync
//! progress. The mDNS scenario is gated behind `#[cfg(not(ci_no_mdns))]`
//! with a manual peer-address override path so the rest of the test runs
//! on CI environments that block multicast.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use ed25519_dalek::SigningKey;
use rand_core::RngCore;
use sha2::{Digest, Sha256};
use snow::TransportState;
use tempfile::TempDir;

use vaultcore_lib::sync::capability::{CapabilityBody, Scope};
use vaultcore_lib::sync::clock::SystemClock;
use vaultcore_lib::sync::conflict::{conflict_copy_path, resolve, ResolveOutcome};
use vaultcore_lib::sync::engine::{InboundDecision, SyncEngine};
use vaultcore_lib::sync::history::HistoryConfig;
use vaultcore_lib::sync::merkle::{diff_paths, MerkleTree};
use vaultcore_lib::sync::pairing::{
    finalize_with_confirmation, key_confirmation_mac, respond, start_initiator, PairingSession,
};
use vaultcore_lib::sync::pairing_engine::{
    drive_initiator_after_pake, drive_responder_after_pake, exchange_vault_grant_initiator,
    exchange_vault_grant_responder,
};
use vaultcore_lib::sync::protocol::{ChangeEvent, ChangeKind, SyncFrame, MAX_FRAME_BYTES};
use vaultcore_lib::sync::state::SyncState;
use vaultcore_lib::sync::transport::{
    drive_handshake, generate_static_keypair, xx_initiator, xx_responder, NoiseKeypair,
};
use vaultcore_lib::sync::ContentHash;
use vaultcore_lib::WriteIgnoreList;

#[cfg(not(ci_no_mdns))]
use vaultcore_lib::sync::discovery::{
    AdvertisedVault, Discovery, MdnsDiscovery, PeerAd, PROTO_VERSION,
};

/// Vault id shared by both devices — this is the *same* vault, replicated.
const VAULT_ID: &str = "e2e-vault-uuid-0001";
const PIN: &str = "314159";
const PROPAGATION_TIMEOUT: Duration = Duration::from_secs(2);
const CATCHUP_TIMEOUT: Duration = Duration::from_secs(1);

/// Noise per-message hard limit (matches the in-tree transport constant
/// — duplicated here because the production module keeps the value private).
const NOISE_MAX_MSG: usize = 65535;
const NOISE_TAG_LEN: usize = 16;
const NOISE_PT_BUDGET: usize = NOISE_MAX_MSG - NOISE_TAG_LEN;

// ─── Polling helper ───────────────────────────────────────────────────

/// Block until `cond` returns true or `deadline` elapses. Returns the
/// elapsed time on success, or `None` on timeout. Yields with a 5ms park
/// between probes so a failing poll burns near-zero CPU but recovers
/// quickly when the expected event fires. The cadence is well below the
/// 2s / 1s budgets the scenarios assert against.
fn wait_until<F: FnMut() -> bool>(deadline: Duration, mut cond: F) -> Option<Duration> {
    let start = Instant::now();
    let stop_at = start + deadline;
    loop {
        if cond() {
            return Some(start.elapsed());
        }
        if Instant::now() >= stop_at {
            return None;
        }
        thread::park_timeout(Duration::from_millis(5));
    }
}

// ─── Hash helper ──────────────────────────────────────────────────────

fn hash(content: &[u8]) -> ContentHash {
    let d = Sha256::digest(content);
    let mut o: ContentHash = [0; 32];
    o.copy_from_slice(&d);
    o
}

// ─── Split-half encrypted peer link ───────────────────────────────────
//
// The in-tree `EncryptedChannel` couples `TcpStream` and `TransportState`
// into a single `&mut self` API — fine for the production engine which
// drives both directions from one task, but a deadlock waiting to happen
// in this test where the reader is parked on `recv` while the writer
// wants to broadcast. We split the two halves: a `Mutex<TransportState>`
// shared between sender + receiver (Noise needs all crypto ops serialized
// — write/read share a transcript hash), and two cloned `TcpStream`
// handles so the actual blocking I/O happens with no Noise lock held.

/// Outbound half: cloned TcpStream owned by the sender thread.
struct PeerOut {
    stream: Mutex<TcpStream>,
    state: Arc<Mutex<TransportState>>,
}

impl PeerOut {
    /// Encrypt + send a `SyncFrame` over the wire. Frame format matches
    /// `EncryptedChannel::send` byte-for-byte:
    ///   [u32 BE bincode_len][noise_chunk]*
    /// where each chunk is `[u16 BE n][ciphertext n bytes]`.
    fn send(&self, frame: &SyncFrame) -> std::io::Result<()> {
        let body = bincode::serialize(frame).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("bincode: {e}"))
        })?;
        if body.len() as u64 > MAX_FRAME_BYTES as u64 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "frame too large",
            ));
        }
        // Build the entire wire payload under the Noise lock, release it,
        // then push to the socket. Holding the Noise lock across blocking
        // socket writes would re-introduce the same deadlock the split
        // is supposed to prevent.
        let mut wire: Vec<u8> = Vec::with_capacity(4 + body.len() + 16);
        wire.extend_from_slice(&(body.len() as u32).to_be_bytes());
        {
            let mut state = self.state.lock().expect("noise state");
            let mut offset = 0usize;
            let mut ct = [0u8; NOISE_MAX_MSG];
            while offset < body.len() {
                let take = (body.len() - offset).min(NOISE_PT_BUDGET);
                let n = state
                    .write_message(&body[offset..offset + take], &mut ct)
                    .map_err(|e| {
                        std::io::Error::new(std::io::ErrorKind::Other, format!("noise: {e}"))
                    })?;
                wire.extend_from_slice(&(n as u16).to_be_bytes());
                wire.extend_from_slice(&ct[..n]);
                offset += take;
            }
        }
        let mut stream = self.stream.lock().expect("stream");
        stream.write_all(&wire)?;
        Ok(())
    }
}

/// Inbound half: cloned TcpStream owned by the reader thread. Owns its
/// own copy of the stream handle (via `try_clone`) so reads and writes
/// proceed in parallel.
struct PeerIn {
    stream: TcpStream,
    state: Arc<Mutex<TransportState>>,
}

impl PeerIn {
    fn recv(&mut self) -> std::io::Result<SyncFrame> {
        let mut len_buf = [0u8; 4];
        self.stream.read_exact(&mut len_buf)?;
        let total = u32::from_be_bytes(len_buf);
        if total > MAX_FRAME_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        // Read all chunks off the wire first (no Noise lock), then
        // decrypt in one pass under the lock. This matches the sender
        // discipline and keeps the Noise mutex un-held during the
        // potentially-blocking socket read.
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        let mut consumed = 0usize;
        while consumed < total as usize {
            let mut n_buf = [0u8; 2];
            self.stream.read_exact(&mut n_buf)?;
            let n = u16::from_be_bytes(n_buf) as usize;
            let mut ct = vec![0u8; n];
            self.stream.read_exact(&mut ct)?;
            // Noise tag is 16 bytes — plaintext per chunk = n - 16.
            consumed += n.saturating_sub(NOISE_TAG_LEN);
            chunks.push(ct);
        }
        let mut body: Vec<u8> = Vec::with_capacity(total as usize);
        let mut state = self.state.lock().expect("noise state");
        let mut pt = [0u8; NOISE_MAX_MSG];
        for ct in chunks {
            let plain_len = state.read_message(&ct, &mut pt).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::Other, format!("noise: {e}"))
            })?;
            body.extend_from_slice(&pt[..plain_len]);
        }
        drop(state);
        let frame: SyncFrame = bincode::deserialize(&body).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("bincode: {e}"))
        })?;
        Ok(frame)
    }
}

/// Split a finished Noise handshake's `(stream, state)` pair into the
/// per-direction halves above.
fn split_link(stream: TcpStream, state: TransportState) -> std::io::Result<(PeerOut, PeerIn)> {
    let read_stream = stream.try_clone()?;
    let state_arc = Arc::new(Mutex::new(state));
    let out = PeerOut {
        stream: Mutex::new(stream),
        state: Arc::clone(&state_arc),
    };
    let inp = PeerIn {
        stream: read_stream,
        state: state_arc,
    };
    Ok((out, inp))
}

// ─── Device wiring ────────────────────────────────────────────────────

/// One sync-stack instance. Holds the on-disk vault root, the metadata
/// store, the engine, and a Noise static key for the transport.
/// Spawned threads (server accept loop + per-peer read loops) push
/// completed `ChangeEvent`s through `apply_remote_event` and mirror the
/// working-tree side effects (write file, delete file, write conflict
/// copy).
struct Device {
    /// Display label, kept around for log messages even when the engine
    /// derives peer names from device ids post-UI-1.5.
    #[allow(dead_code)]
    name: &'static str,
    self_peer_id: String,
    /// Ed25519 long-term key — used to sign capability grants.
    signing_key: SigningKey,
    /// Curve25519 Noise static — used by the transport handshake.
    noise_kp: NoiseKeypair,
    vault_root: PathBuf,
    state: Arc<SyncState>,
    engine: Arc<SyncEngine>,
    server: Mutex<Option<RunningServer>>,
    /// Outbound peer connections, keyed by peer device_id. Sends are
    /// serialized per-peer through `PeerOut`'s internal mutex.
    peers: Mutex<HashMap<String, Arc<PeerOut>>>,
    _tmp: TempDir,
}

struct RunningServer {
    addr: SocketAddr,
    stop_flag: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Device {
    fn new(name: &'static str) -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let vault_root = tmp.path().to_path_buf();
        let metadata = vault_root.join(".vaultcore");
        std::fs::create_dir_all(&metadata).expect("metadata dir");

        let signing_key = fresh_signing_key();
        let device_id = derive_test_device_id(&signing_key);
        let noise_kp = generate_static_keypair().expect("noise kp");

        let state = Arc::new(
            SyncState::open_with(
                &metadata,
                device_id.clone(),
                Arc::new(SystemClock),
                HistoryConfig::default(),
            )
            .expect("sync state open"),
        );

        let write_ignore = Arc::new(Mutex::new(WriteIgnoreList::default()));
        let engine = Arc::new(SyncEngine::new(state.clone(), write_ignore));
        engine
            .set_vault_root(vault_root.clone())
            .expect("set vault root");

        Self {
            name,
            self_peer_id: device_id,
            signing_key,
            noise_kp,
            vault_root,
            state,
            engine,
            server: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            _tmp: tmp,
        }
    }

    fn start_server(self: &Arc<Self>) -> SocketAddr {
        let listener = TcpListener::bind((Ipv4Addr::new(127, 0, 0, 1), 0)).expect("bind");
        listener
            .set_nonblocking(true)
            .expect("listener nonblocking");
        let addr = listener.local_addr().expect("local addr");
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_t = Arc::clone(&stop_flag);
        let me = Arc::clone(self);
        let join = thread::spawn(move || {
            accept_loop(me, listener, stop_flag_t);
        });
        *self.server.lock().expect("server lock") = Some(RunningServer {
            addr,
            stop_flag,
            join: Some(join),
        });
        addr
    }

    fn stop_server(&self) {
        let Some(mut srv) = self.server.lock().expect("server lock").take() else {
            return;
        };
        srv.stop_flag.store(true, Ordering::SeqCst);
        if let Some(j) = srv.join.take() {
            let _ = j.join();
        }
        let mut peers = self.peers.lock().expect("peers lock");
        for (_, ch) in peers.drain() {
            if let Ok(s) = ch.stream.lock() {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
    }

    fn server_addr(&self) -> Option<SocketAddr> {
        self.server
            .lock()
            .expect("server lock")
            .as_ref()
            .map(|s| s.addr)
    }

    /// Local write: persist to disk, record in sync state + Merkle tree,
    /// then broadcast to every connected peer.
    fn write_local(&self, rel: &str, content: &[u8]) {
        let abs = self.vault_root.join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&abs, content).expect("write local");
        let h = hash(content);
        let event = self
            .engine
            .on_local_write(VAULT_ID, PathBuf::from(rel), content.to_vec(), h)
            .expect("on_local_write");
        let tree = MerkleTree::new(&self.state, VAULT_ID);
        tree.upsert_file(rel, h).expect("merkle upsert");
        self.broadcast(SyncFrame::Change(event));
    }

    /// Local delete: drop the file, record a tombstone, broadcast the
    /// matching `Deleted` event.
    fn delete_local(&self, rel: &str) {
        let abs = self.vault_root.join(rel);
        let _ = std::fs::remove_file(&abs);
        let mut vv = self
            .state
            .get_file(VAULT_ID, rel)
            .expect("get_file")
            .map(|r| r.version_vector)
            .unwrap_or_default();
        vv.increment(&self.self_peer_id);
        self.state
            .tombstones()
            .record_delete(VAULT_ID, rel, &vv)
            .expect("record tombstone");
        let tree = MerkleTree::new(&self.state, VAULT_ID);
        tree.remove_file(rel).expect("merkle remove");
        let event = ChangeEvent {
            vault_id: VAULT_ID.into(),
            path: PathBuf::from(rel),
            kind: ChangeKind::Deleted,
            source_peer: self.self_peer_id.clone(),
            version_vector: vv,
            content_hash: [0u8; 32],
        };
        self.broadcast(SyncFrame::Change(event));
    }

    fn broadcast(&self, frame: SyncFrame) {
        let peers: Vec<Arc<PeerOut>> = self
            .peers
            .lock()
            .expect("peers lock")
            .values()
            .cloned()
            .collect();
        for ch in peers {
            // Best-effort send; a dead connection is fine — the catch-up
            // path picks the file up via Merkle on reconnect.
            let _ = ch.send(&frame);
        }
    }

    fn file_contents(&self, rel: &str) -> Option<Vec<u8>> {
        std::fs::read(self.vault_root.join(rel)).ok()
    }

    fn file_exists(&self, rel: &str) -> bool {
        self.vault_root.join(rel).exists()
    }

    /// Walk the working tree looking for any conflict-copy file matching
    /// `<stem> (conflict from … YYYY-MM-DD HH:MM)<.ext>`.
    fn find_conflict_copy(&self, parent: &str, stem_prefix: &str) -> Option<PathBuf> {
        let dir = self.vault_root.join(parent);
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{stem_prefix} (conflict from "))
                && name.ends_with(").md")
            {
                return Some(entry.path());
            }
        }
        None
    }

    fn merkle_root(&self) -> Option<ContentHash> {
        MerkleTree::new(&self.state, VAULT_ID)
            .root()
            .expect("merkle root")
    }
}

// ─── Trust + capability bootstrapping ─────────────────────────────────

/// Mutually pair A and B in-process via PAKE + key-confirmation, then
/// drive the engine integration layer (`pairing_engine`) end-to-end:
/// Noise XX bootstrap, long-term key attestation under k2 →
/// `state.upsert_peer(.., Trusted)` on both sides, vault-grant exchange
/// → `state.upsert_vault_grant(..)` on both sides. Returns the open
/// noise channel A→B so the test's `peers` map can pick up where the
/// engine left off.
///
/// This is the regression check for UI-1.5: the manual upsert calls
/// have been replaced by `drive_*_after_pake` + `exchange_vault_grant_*`,
/// and any drift between the engine's persistence and what the e2e
/// scenarios expect would surface as the test breaking.
fn pair_and_connect(a: &Arc<Device>, b: &Arc<Device>, addr_b_listening: SocketAddr) {
    // ─── Step 1: PAKE round-trip (matching PIN, in-process). ──────────
    let session_a = PairingSession::new();
    let session_b = PairingSession::new();
    session_a.issue_pin().expect("a issue pin");
    session_b.issue_pin().expect("b issue pin");

    let initiator = start_initiator(PIN, &a.self_peer_id, &b.self_peer_id).expect("pake start");
    let s1 = initiator.step1_packet();
    let responder = respond(&s1, PIN, &a.self_peer_id, &b.self_peer_id).expect("pake respond");
    let s2 = responder.step2_packet();
    let raw_a = initiator.step3(&s2).expect("pake step3");
    let raw_b = responder.raw_keys;
    let mac_b = key_confirmation_mac(&raw_b.k2, &a.self_peer_id, &b.self_peer_id);
    let mac_a = key_confirmation_mac(&raw_a.k2, &a.self_peer_id, &b.self_peer_id);
    finalize_with_confirmation(&raw_a, &mac_b, &session_a).expect("a finalize");
    finalize_with_confirmation(&raw_b, &mac_a, &session_b).expect("b finalize");
    let k2_a = raw_a.k2;
    let k2_b = raw_b.k2;

    // ─── Step 2: drive the engine on B (responder thread). ────────────
    // The accept_loop on B is purposely *not* used during pairing — it
    // only kicks in for steady-state IK reconnects. Pairing wants a
    // dedicated listener so the engine controls both sides of the XX
    // handshake without racing the steady-state acceptor.
    let pairing_listener =
        TcpListener::bind((Ipv4Addr::new(127, 0, 0, 1), 0)).expect("pairing bind");
    let pairing_addr = pairing_listener.local_addr().expect("pairing addr");
    let b_for_thread = Arc::clone(b);
    let a_id_for_thread = a.self_peer_id.clone();
    let pair_thread = thread::spawn(move || {
        let (mut stream, _) = pairing_listener
            .accept()
            .expect("pairing accept");
        stream.set_nodelay(true).ok();
        let mut session = drive_responder_after_pake(
            &mut stream,
            &b_for_thread.noise_kp,
            &b_for_thread.signing_key,
            &b_for_thread.self_peer_id,
            &a_id_for_thread,
            &k2_b,
            &b_for_thread.state,
        )
        .expect("b drive responder");
        let body_b = CapabilityBody::issue_v1(
            VAULT_ID,
            &b_for_thread.self_peer_id,
            VAULT_ID,
            Scope::ReadWrite,
        );
        exchange_vault_grant_responder(
            &mut session,
            &b_for_thread.signing_key,
            &body_b,
            &a_id_for_thread,
            &b_for_thread.state,
        )
        .expect("b grant exchange");
    });

    // ─── Step 3: drive the engine on A (initiator). ──────────────────
    let mut stream = TcpStream::connect(pairing_addr).expect("pairing connect");
    stream.set_nodelay(true).ok();
    let mut session = drive_initiator_after_pake(
        &mut stream,
        &a.noise_kp,
        &a.signing_key,
        &a.self_peer_id,
        &b.self_peer_id,
        &k2_a,
        &a.state,
    )
    .expect("a drive initiator");
    let body_a = CapabilityBody::issue_v1(
        VAULT_ID,
        &a.self_peer_id,
        VAULT_ID,
        Scope::ReadWrite,
    );
    exchange_vault_grant_initiator(
        &mut session,
        &a.signing_key,
        &body_a,
        &b.self_peer_id,
        &a.state,
    )
    .expect("a grant exchange");
    pair_thread.join().expect("pairing thread");
    // The pairing socket is no longer needed for sync — we close it and
    // open a fresh sync connection through the steady-state accept loop
    // below. (Reusing the pairing socket would require teaching the
    // accept loop on B to skip the XX dance for already-bootstrapped
    // peers; out of scope for this layer.)
    drop(session);

    // ─── Step 4: open the steady-state Noise channel A→B + register reader. ───
    open_outbound(a, b, addr_b_listening);
    let _ = wait_until(Duration::from_secs(2), || {
        b.peers
            .lock()
            .map(|g| g.contains_key(&a.self_peer_id))
            .unwrap_or(false)
    });
}

/// Open a fresh outbound link from `a` to `b`. Used by both the initial
/// pairing connect and by `reconnect` (the persisted peer + grant rows
/// outlive the TCP socket).
fn open_outbound(a: &Arc<Device>, b: &Arc<Device>, addr_b_listening: SocketAddr) {
    let mut stream = TcpStream::connect(addr_b_listening).expect("connect");
    stream.set_nodelay(true).expect("nodelay");
    let hs = xx_initiator(&a.noise_kp.private).expect("xx_initiator");
    let (transport, _remote_static) =
        drive_handshake(hs, &mut stream, true).expect("handshake initiator");
    let (out, inp) = split_link(stream, transport).expect("split link");
    let out_arc = Arc::new(out);
    a.peers
        .lock()
        .expect("a peers lock")
        .insert(b.self_peer_id.clone(), Arc::clone(&out_arc));
    let a_for_reader = Arc::clone(a);
    let peer_id_b = b.self_peer_id.clone();
    thread::spawn(move || peer_read_loop(a_for_reader, peer_id_b, inp));
}

// ─── Server side accept + per-connection driver ───────────────────────

fn accept_loop(device: Arc<Device>, listener: TcpListener, stop_flag: Arc<AtomicBool>) {
    while !stop_flag.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _peer_addr)) => {
                stream.set_nodelay(true).ok();
                stream.set_nonblocking(false).ok();
                let device_t = Arc::clone(&device);
                thread::spawn(move || {
                    serve_inbound(device_t, stream);
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::park_timeout(Duration::from_millis(10));
            }
            Err(_) => {
                thread::park_timeout(Duration::from_millis(10));
            }
        }
    }
}

/// Responder side of the Noise XX handshake. Once the channel is up,
/// the connection is symmetric — register on the outbound peers map +
/// run a reader. Caveat: the responder doesn't know the peer's device
/// id until the first frame arrives (frames carry `source_peer`), so we
/// peek at the first frame, use its `source_peer` as the registration
/// key, then process it and continue reading.
fn serve_inbound(device: Arc<Device>, mut stream: TcpStream) {
    let hs = match xx_responder(&device.noise_kp.private) {
        Ok(hs) => hs,
        Err(_) => return,
    };
    let (transport, _remote_static) = match drive_handshake(hs, &mut stream, false) {
        Ok(out) => out,
        Err(_) => return,
    };
    let (out, mut inp) = match split_link(stream, transport) {
        Ok(p) => p,
        Err(_) => return,
    };
    let out_arc = Arc::new(out);

    // Discover peer id from the first inbound frame, register the
    // outbound half, then stay in the reader loop.
    let first_frame = match inp.recv() {
        Ok(f) => f,
        Err(_) => return,
    };
    let peer_id = peer_id_of(&first_frame).map(|s| s.to_string()).unwrap_or_default();
    if !peer_id.is_empty() {
        device
            .peers
            .lock()
            .expect("peers lock")
            .insert(peer_id.clone(), Arc::clone(&out_arc));
    }
    handle_frame(&device, &peer_id, first_frame);
    peer_read_loop(device, peer_id, inp);
}

fn peer_read_loop(device: Arc<Device>, peer_id: String, mut inp: PeerIn) {
    loop {
        let frame = match inp.recv() {
            Ok(f) => f,
            Err(_) => return,
        };
        handle_frame(&device, &peer_id, frame);
    }
}

fn peer_id_of(frame: &SyncFrame) -> Option<&str> {
    match frame {
        SyncFrame::Change(e) => Some(&e.source_peer),
        _ => None,
    }
}

/// Consume one inbound frame: validate via engine, then mirror the
/// decision onto the working tree. This is the "watcher hook" the
/// production code wires up in `lib.rs`; in this test it lives inline
/// because we don't want to bring up Tauri / notify.
fn handle_frame(device: &Arc<Device>, peer_id: &str, frame: SyncFrame) {
    let event = match frame {
        SyncFrame::Change(e) => e,
        // Batch markers are no-ops at this layer.
        _ => return,
    };
    let decision = match device.engine.apply_remote_event(&event, peer_id) {
        Ok(d) => d,
        Err(_) => return,
    };
    match decision {
        InboundDecision::FastForward {
            path,
            content,
            content_hash,
        }
        | InboundDecision::Created {
            path,
            content,
            content_hash,
        } => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&path, &content);
            let rel = relative_to(&device.vault_root, &path);
            let tree = MerkleTree::new(&device.state, VAULT_ID);
            let _ = tree.upsert_file(&rel, content_hash);
        }
        InboundDecision::Delete { path } => {
            let _ = std::fs::remove_file(&path);
            let rel = relative_to(&device.vault_root, &path);
            let tree = MerkleTree::new(&device.state, VAULT_ID);
            let _ = tree.remove_file(&rel);
        }
        InboundDecision::NeedsMerge {
            path,
            remote_content,
            remote_hash: _,
        } => {
            let rel = relative_to(&device.vault_root, &path);
            let local_record = match device.state.get_file(VAULT_ID, &rel) {
                Ok(Some(r)) => r,
                _ => return,
            };
            let local_content = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => return,
            };
            let outcome = match resolve(
                &device.state,
                VAULT_ID,
                Path::new(&rel),
                &local_record,
                &local_content,
                &remote_content,
                &event.version_vector,
                peer_id,
            ) {
                Ok(o) => o,
                Err(_) => return,
            };
            match outcome {
                ResolveOutcome::Merged {
                    merged_content,
                    merged_vv: _,
                } => {
                    let _ = std::fs::write(&path, &merged_content);
                }
                ResolveOutcome::OverlapKeptLocal {
                    copy_path,
                    copy_content,
                }
                | ResolveOutcome::NoBaseInHistory {
                    copy_path,
                    copy_content,
                } => {
                    let abs_copy = device.vault_root.join(&copy_path);
                    if let Some(parent) = abs_copy.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&abs_copy, &copy_content);
                }
            }
        }
        InboundDecision::Rename { from, to } => {
            let _ = std::fs::rename(&from, &to);
        }
        InboundDecision::Discard | InboundDecision::Rejected { .. } => {}
    }
}

fn relative_to(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| abs.to_string_lossy().to_string())
}

// ─── Catch-up reconciliation (Merkle-driven pull) ─────────────────────

/// On reconnect, `local` compares its Merkle tree against `remote`'s and
/// pulls every differing-or-missing path back from `remote`'s
/// `sync_files` + `History`. Models the production catch-up loop in a
/// test-friendly form: read peer's tree in-process via a closure (the
/// production path runs the same descent over the wire).
fn catchup_pull_from(local: &Arc<Device>, remote: &Arc<Device>) -> Duration {
    let start = Instant::now();
    let local_tree = MerkleTree::new(&local.state, VAULT_ID);
    let remote_tree = MerkleTree::new(&remote.state, VAULT_ID);

    let mut peer_lookup = |p: &str| remote_tree.node(p).ok().flatten();
    let differing = diff_paths(&local_tree, &mut peer_lookup).unwrap_or_default();
    for rel in &differing {
        pull_one(local, remote, rel);
    }

    // Also pull remote-only paths the local tree never registered.
    let local_paths = collect_files(&local_tree);
    for rel in collect_files(&remote_tree) {
        if !local_paths.contains(&rel) {
            pull_one(local, remote, &rel);
        }
    }
    start.elapsed()
}

fn pull_one(local: &Arc<Device>, remote: &Arc<Device>, rel: &str) {
    let Ok(Some(rec)) = remote.state.get_file(VAULT_ID, rel) else {
        return;
    };
    let Ok(Some(content)) = remote
        .state
        .get_history(VAULT_ID, rel, &rec.content_hash)
    else {
        return;
    };
    let evt = ChangeEvent {
        vault_id: VAULT_ID.into(),
        path: PathBuf::from(rel),
        kind: ChangeKind::Upserted {
            content: content.clone(),
        },
        source_peer: remote.self_peer_id.clone(),
        version_vector: rec.version_vector.clone(),
        content_hash: rec.content_hash,
    };
    handle_frame(local, &remote.self_peer_id, SyncFrame::Change(evt));
}

fn collect_files(tree: &MerkleTree<'_>) -> HashSet<String> {
    fn walk(tree: &MerkleTree<'_>, folder: &str, out: &mut HashSet<String>) {
        let Ok(children) = tree.children(folder) else {
            return;
        };
        for c in children {
            match c.kind {
                vaultcore_lib::sync::merkle::NodeKind::File => {
                    out.insert(c.path);
                }
                vaultcore_lib::sync::merkle::NodeKind::Folder => walk(tree, &c.path, out),
            }
        }
    }
    let mut out = HashSet::new();
    walk(tree, "", &mut out);
    out
}

// ─── Identity helpers ─────────────────────────────────────────────────

fn fresh_signing_key() -> SigningKey {
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    SigningKey::from_bytes(&bytes)
}

/// `device_id = base32(SHA-256(pubkey)[..16])` — same recipe as
/// `identity::derive_device_id` but tests can't reach in there without
/// pulling the full `Identity` ceremony (which requires an OS keychain).
fn derive_test_device_id(sk: &SigningKey) -> String {
    use data_encoding::BASE32_NOPAD;
    let pubkey = sk.verifying_key().to_bytes();
    let digest = Sha256::digest(pubkey);
    BASE32_NOPAD.encode(&digest[..16])
}

// ─── mDNS discovery (cfg-gated for CI) ────────────────────────────────

#[cfg(not(ci_no_mdns))]
fn discover_peer_addr_via_mdns(
    self_id: &str,
    self_port: u16,
    peer_id: &str,
) -> Option<(MdnsDiscovery, SocketAddr)> {
    let d = MdnsDiscovery::new().ok()?;
    let ad = PeerAd {
        device_id: self_id.to_string(),
        name: self_id.into(),
        vaults: vec![AdvertisedVault {
            id: VAULT_ID.into(),
            name: "E2E".into(),
        }],
        pubkey_fp: self_id.chars().take(8).collect(),
        proto: PROTO_VERSION.to_string(),
        addrs: Vec::new(),
        port: self_port,
    };
    d.start(ad).ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(snap) = d.peers() {
            if let Some(p) = snap.peers.iter().find(|p| p.device_id == peer_id) {
                let ip = p
                    .addrs
                    .iter()
                    .find(|a| matches!(a, IpAddr::V4(_)))
                    .copied()
                    .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
                return Some((d, SocketAddr::new(ip, p.port)));
            }
        }
        thread::park_timeout(Duration::from_millis(150));
    }
    let _ = d.stop();
    None
}

// ─── The single end-to-end test ───────────────────────────────────────

#[test]
fn lan_sync_two_devices_loopback_full_acceptance() {
    eprintln!("[e2e] device init");
    let a = Arc::new(Device::new("alice"));
    let b = Arc::new(Device::new("bob"));

    eprintln!("[e2e] start servers");
    a.start_server();
    let addr_b_listening = b.start_server();
    eprintln!("[e2e] B listening @ {addr_b_listening}");

    // ─── Discovery: try mDNS first, fall back to direct override ─────
    // The test still pairs over the directly-known address afterwards
    // — the mDNS step is purely "did the loopback advertiser see the
    // listener". This matches the spec's "may not work on all CI
    // environments" caveat: success is informational, failure is
    // tolerated.
    #[cfg(not(ci_no_mdns))]
    let _mdns_handles: Option<(MdnsDiscovery, MdnsDiscovery)> = {
        let port_a = a.server_addr().unwrap().port();
        let port_b = b.server_addr().unwrap().port();
        let a_disc = discover_peer_addr_via_mdns(&a.self_peer_id, port_a, &b.self_peer_id);
        let b_disc = discover_peer_addr_via_mdns(&b.self_peer_id, port_b, &a.self_peer_id);
        match (a_disc, b_disc) {
            (Some((da, addr_b_via_mdns)), Some((db, _))) => {
                assert_eq!(
                    addr_b_via_mdns.port(),
                    addr_b_listening.port(),
                    "mDNS-resolved port must match listener"
                );
                println!("[e2e] mDNS discovery succeeded");
                Some((da, db))
            }
            _ => {
                println!("[e2e] mDNS discovery skipped/unavailable on this host");
                None
            }
        }
    };

    // ─── PAKE pair + connect (always; mDNS only resolves the address). ──
    eprintln!("[e2e] pair+connect start");
    pair_and_connect(&a, &b, addr_b_listening);
    eprintln!("[e2e] pair+connect done");

    // ─── Scenario 4: write `note.md` on A → B sees it within 2s. ──────
    eprintln!("[e2e] s4: write note.md on A");
    a.write_local("note.md", b"hello from alice");
    eprintln!("[e2e] s4: wait for propagation");
    let prop1 = wait_until(PROPAGATION_TIMEOUT, || {
        b.file_contents("note.md").as_deref() == Some(b"hello from alice".as_ref())
    })
    .expect("note.md must propagate to B within 2s");
    println!(
        "[e2e] propagation A→B (note.md): {} ms",
        prop1.as_millis()
    );

    // ─── Scenario 5: concurrent edit → conflict-copy on the loser. ───
    // Drop the live channel so each side's write happens under network
    // partition. After reconnect, both sides have made a write off the
    // same v1 base — VVs are concurrent → conflict copy.
    drop_connections(&a, &b);

    a.write_local("note.md", b"alice's concurrent edit");
    b.write_local("note.md", b"bob's concurrent edit");

    reconnect(&a, &b, addr_b_listening);
    rebroadcast_latest(&a, "note.md");
    rebroadcast_latest(&b, "note.md");

    let conflict = wait_until(PROPAGATION_TIMEOUT, || {
        a.find_conflict_copy("", "note").is_some() || b.find_conflict_copy("", "note").is_some()
    });
    assert!(
        conflict.is_some(),
        "a conflict-copy file must appear within 2s"
    );
    let copy_path = a
        .find_conflict_copy("", "note")
        .or_else(|| b.find_conflict_copy("", "note"))
        .expect("conflict copy path");
    let name = copy_path.file_name().unwrap().to_string_lossy().to_string();
    assert!(
        name.starts_with("note (conflict from "),
        "obsidian-compatible name expected, got {name}"
    );
    assert!(
        name.ends_with(").md"),
        "obsidian-compatible name expected, got {name}"
    );
    // Sanity: the canonical formatter produces the same shape.
    let canonical = conflict_copy_path(Path::new("note.md"), "peer", &a.state);
    let canonical_name = canonical.file_name().unwrap().to_string_lossy().to_string();
    assert!(
        canonical_name.starts_with("note (conflict from peer "),
        "canonical formatter shape sanity: {canonical_name}"
    );
    println!("[e2e] conflict-copy filename: {name}");

    // ─── Scenario 6: delete on A → tombstone propagates → file gone on B. ──
    // Clean up the diverged note.md on B first so the delete event
    // applies cleanly. (B's note.md is the side that "won" — we want
    // the user-visible state to converge after the delete.)
    a.delete_local("note.md");
    let prop_del = wait_until(PROPAGATION_TIMEOUT, || !b.file_exists("note.md"))
        .expect("note.md deletion must propagate to B within 2s");
    println!(
        "[e2e] tombstone propagation A→B: {} ms",
        prop_del.as_millis()
    );
    assert!(
        b.state
            .tombstones()
            .is_tombstoned(VAULT_ID, "note.md")
            .unwrap(),
        "B must record a live tombstone after receiving the delete"
    );

    // ─── Scenario 7: B offline, A writes 3 files, B reconnects → catch-up. ──
    drop_connections(&a, &b);

    a.write_local("docs/one.md", b"one");
    a.write_local("docs/two.md", b"two");
    a.write_local("docs/three.md", b"three");

    reconnect(&a, &b, addr_b_listening);
    let catchup_elapsed = catchup_pull_from(&b, &a);
    assert!(
        catchup_elapsed <= CATCHUP_TIMEOUT,
        "Merkle catch-up must reconcile 3 files within 1s, took {} ms",
        catchup_elapsed.as_millis()
    );
    for rel in ["docs/one.md", "docs/two.md", "docs/three.md"] {
        assert!(
            b.file_exists(rel),
            "B must have caught up file {rel} after Merkle reconciliation"
        );
    }
    let root_a = a.merkle_root();
    let root_b = b.merkle_root();
    assert_eq!(
        root_a, root_b,
        "Merkle roots must match after catch-up; mismatch implies divergence"
    );
    println!(
        "[e2e] Merkle catch-up (3 files): {} ms",
        catchup_elapsed.as_millis()
    );

    // ─── Teardown ────────────────────────────────────────────────────
    a.stop_server();
    b.stop_server();
}

// ─── Connection-management helpers ────────────────────────────────────

fn drop_connections(a: &Arc<Device>, b: &Arc<Device>) {
    for d in [a, b] {
        let mut peers = d.peers.lock().expect("peers lock");
        for (_, ch) in peers.drain() {
            if let Ok(s) = ch.stream.lock() {
                let _ = s.shutdown(Shutdown::Both);
            }
        }
    }
}

fn reconnect(a: &Arc<Device>, b: &Arc<Device>, addr_b_listening: SocketAddr) {
    open_outbound(a, b, addr_b_listening);
    let _ = wait_until(Duration::from_secs(2), || {
        b.peers
            .lock()
            .map(|g| g.contains_key(&a.self_peer_id))
            .unwrap_or(false)
    });
}

/// Re-emit the most recent change for `rel` to all currently connected
/// peers. Used to drive concurrent writes through the wire after a
/// reconnect — without this, the write happens while the channel is
/// down and the broadcast goes nowhere.
fn rebroadcast_latest(device: &Arc<Device>, rel: &str) {
    let Ok(Some(rec)) = device.state.get_file(VAULT_ID, rel) else {
        return;
    };
    let Ok(Some(content)) = device
        .state
        .get_history(VAULT_ID, rel, &rec.content_hash)
    else {
        return;
    };
    let evt = ChangeEvent {
        vault_id: VAULT_ID.into(),
        path: PathBuf::from(rel),
        kind: ChangeKind::Upserted { content },
        source_peer: device.self_peer_id.clone(),
        version_vector: rec.version_vector.clone(),
        content_hash: rec.content_hash,
    };
    device.broadcast(SyncFrame::Change(evt));
}
