//! Tauri commands for the LAN sync layer (epic #73).
//!
//! Today this is a thin shim — the only user-facing surface from #417 is
//! the "Discoverable on this network" toggle. Backend wires the bool into
//! `VaultState`; the actual mDNS daemon lifecycle is plumbed in #419
//! (Noise transport + sync wiring), where we have a sync engine to start.

use std::sync::atomic::{AtomicBool, Ordering};

/// Single global flag mirroring the user's "Discoverable on this network"
/// preference. Default `true` per epic #73's "Settings → Sync →
/// Discoverable on this network (default on)" line.
///
/// Held as a process-wide static rather than a `VaultState` field because
/// the toggle outlives any single open vault — the user might close one
/// vault and open another while sync stays advertising the new one.
pub static DISCOVERABLE: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub fn sync_set_discoverable(enabled: bool) {
    DISCOVERABLE.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
pub fn sync_get_discoverable() -> bool {
    DISCOVERABLE.load(Ordering::SeqCst)
}
