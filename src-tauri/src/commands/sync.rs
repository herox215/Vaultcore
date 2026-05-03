//! Legacy sync state used by the v0 toggle (epic #73 sub-issue #417).
//!
//! UI-1 superseded the Tauri command surface defined in this file —
//! `commands::sync_cmds` now owns both `sync_get_discoverable` and
//! `sync_set_discoverable` and routes them through `SyncRuntime`,
//! which actually starts/stops the mDNS daemon.
//!
//! The `DISCOVERABLE` static stays here so any non-IPC call site that
//! reads the flag (e.g. transport-layer code in #419) continues to
//! compile. `SyncRuntime::set_discoverable` mirrors writes into this
//! static so the two views stay in sync.

use std::sync::atomic::AtomicBool;

/// Process-wide mirror of the user's "Discoverable on this network"
/// preference. Written by [`crate::commands::sync_cmds::SyncRuntime::set_discoverable`];
/// retained as a separate static so non-IPC consumers can read the flag
/// without taking a Tauri-state dependency.
pub static DISCOVERABLE: AtomicBool = AtomicBool::new(true);
