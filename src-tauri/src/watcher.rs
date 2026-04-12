//! File watcher module — spawns notify-debouncer-full on vault open.
//!
//! Responsibilities:
//! - Spawn a recursive watcher over the vault directory using notify-debouncer-full
//! - Filter self-writes via WriteIgnoreList (D-12)
//! - Filter dot-prefixed directory components (.obsidian/, .trash/, .git/, etc.)
//! - Detect bulk-change bursts (>500 events) and switch to progress UI mode (D-13)
//! - Emit typed Tauri events: vault://file_changed, vault://bulk_change_start,
//!   vault://bulk_change_end, vault://watcher_error, vault://vault_status

use notify_debouncer_full::{
    new_debouncer,
    notify::{event::ModifyKind, EventKind, RecursiveMode},
    DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use notify_debouncer_full::notify::RecommendedWatcher;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::WriteIgnoreList;

// ─── Constants ────────────────────────────────────────────────────────────────

/// Debounce window: events within 200ms of each other are coalesced (D-10).
const DEBOUNCE_DURATION: Duration = Duration::from_millis(200);

/// If a single debounced batch contains more than this many events, switch to
/// bulk-change mode and show the progress UI instead of per-file toasts (D-13).
const BULK_THRESHOLD: usize = 500;

// ─── Event payload types ───────────────────────────────────────────────────────

/// Payload for vault://file_changed events.
#[derive(Serialize, Clone, Debug)]
pub struct FileChangePayload {
    pub path: String,
    /// One of: "create", "modify", "delete", "rename"
    pub kind: String,
    /// Only set when kind == "rename"
    pub new_path: Option<String>,
}

/// Payload for vault://bulk_change_start events.
#[derive(Serialize, Clone, Debug)]
pub struct BulkChangePayload {
    pub estimated_count: usize,
}

/// Payload for vault://vault_status events.
#[derive(Serialize, Clone, Debug)]
pub struct VaultStatusPayload {
    pub reachable: bool,
}

// ─── Event name constants ───────────────────────────────────────────────────────

const FILE_CHANGED_EVENT: &str = "vault://file_changed";
const BULK_CHANGE_START_EVENT: &str = "vault://bulk_change_start";
const BULK_CHANGE_END_EVENT: &str = "vault://bulk_change_end";
const VAULT_STATUS_EVENT: &str = "vault://vault_status";
const WATCHER_ERROR_EVENT: &str = "vault://watcher_error";

// ─── Public API ───────────────────────────────────────────────────────────────

/// Spawn a recursive file watcher over `vault_path`.
///
/// Returns a `Debouncer` handle that MUST be kept alive in `VaultState` for
/// the watcher to remain active. Dropping it stops the watcher.
///
/// Events are debounced at 200ms, self-writes filtered via `write_ignore`,
/// and dot-prefixed paths filtered before emission.
pub fn spawn_watcher(
    app: AppHandle,
    vault_path: PathBuf,
    write_ignore: Arc<Mutex<WriteIgnoreList>>,
) -> Debouncer<RecommendedWatcher, RecommendedCache> {
    let vault_path_clone = vault_path.clone();

    let mut debouncer = new_debouncer(
        DEBOUNCE_DURATION,
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                process_events(&app, &write_ignore, &vault_path_clone, events);
            }
            Err(errors) => {
                for error in errors {
                    // Check if this is a path-not-found error on the vault root,
                    // which indicates the vault has been unmounted (ERR-03).
                    let is_vault_missing = error.paths.iter().any(|p| p == &vault_path_clone)
                        || format!("{:?}", error.kind).contains("NotFound");

                    if is_vault_missing {
                        let _ = app.emit(
                            VAULT_STATUS_EVENT,
                            VaultStatusPayload { reachable: false },
                        );
                    }

                    let _ = app.emit(
                        WATCHER_ERROR_EVENT,
                        serde_json::json!({ "message": format!("{:?}", error.kind) }),
                    );
                }
            }
        },
    )
    .expect("Failed to create file watcher debouncer");

    debouncer
        .watch(&vault_path, RecursiveMode::Recursive)
        .expect("Failed to start watching vault directory");

    debouncer
}

/// Returns `true` if the path contains any dot-prefixed component relative to
/// `vault_path`. This filters .obsidian/, .trash/, .git/, .DS_Store, etc.
///
/// `pub(crate)` for unit-test access.
pub(crate) fn is_hidden_path(vault_path: &Path, event_path: &Path) -> bool {
    // Strip the vault prefix to get the relative path
    let relative = match event_path.strip_prefix(vault_path) {
        Ok(r) => r,
        // If strip fails (path outside vault), treat as hidden to be safe
        Err(_) => return true,
    };

    // Check each component of the relative path
    for component in relative.components() {
        use std::path::Component;
        if let Component::Normal(name) = component {
            let s = name.to_str().unwrap_or("");
            if s.starts_with('.') {
                return true;
            }
        }
    }
    false
}

// ─── Internal event processing ─────────────────────────────────────────────────

/// Process a batch of debounced events:
/// 1. Filter dot-prefixed paths (T-02-14 mitigation)
/// 2. Filter self-writes via write_ignore list (D-12)
/// 3. Check bulk-change threshold (D-13)
/// 4. Emit typed Tauri events
fn process_events(
    app: &AppHandle,
    write_ignore: &Arc<Mutex<WriteIgnoreList>>,
    vault_path: &Path,
    events: Vec<DebouncedEvent>,
) {
    // Step 1: Filter dot-prefixed paths
    let filtered: Vec<DebouncedEvent> = events
        .into_iter()
        .filter(|ev| {
            // An event may have multiple paths (e.g., rename: [from, to]).
            // Skip if the primary path (paths[0]) is dot-prefixed.
            ev.paths
                .first()
                .map(|p| !is_hidden_path(vault_path, p))
                .unwrap_or(false)
        })
        .collect();

    // Step 2: Filter self-writes via write_ignore
    let filtered: Vec<DebouncedEvent> = {
        let ignore = write_ignore.lock().unwrap_or_else(|e| e.into_inner());
        filtered
            .into_iter()
            .filter(|ev| {
                ev.paths
                    .first()
                    .map(|p| !ignore.should_ignore(p))
                    .unwrap_or(false)
            })
            .collect()
    };

    // Step 3: Bulk-change detection
    let count = filtered.len();
    if count > BULK_THRESHOLD {
        let _ = app.emit(
            BULK_CHANGE_START_EVENT,
            BulkChangePayload { estimated_count: count },
        );
    }

    // Step 4: Emit individual file_changed events
    for ev in filtered {
        if let Some(payload) = map_event_to_payload(vault_path, &ev) {
            let _ = app.emit(FILE_CHANGED_EVENT, payload);
        }
    }

    // Step 3 (continued): Emit bulk_change_end after processing all events
    if count > BULK_THRESHOLD {
        let _ = app.emit(BULK_CHANGE_END_EVENT, serde_json::json!({}));
    }
}

/// Map a notify DebouncedEvent to a FileChangePayload.
/// Returns None for event kinds we don't handle.
fn map_event_to_payload(vault_path: &Path, ev: &DebouncedEvent) -> Option<FileChangePayload> {
    let primary_path = ev.paths.first()?.to_string_lossy().into_owned();

    // T-02-16 mitigation: only emit paths within vault scope
    if let Some(p) = ev.paths.first() {
        if !p.starts_with(vault_path) {
            return None;
        }
    }

    let kind_str = match &ev.kind {
        EventKind::Create(_) => "create".to_string(),
        EventKind::Remove(_) => "delete".to_string(),
        EventKind::Modify(ModifyKind::Name(_)) => {
            // Rename event — new_path is paths[1] if available
            let new_path = ev.paths.get(1).map(|p| p.to_string_lossy().into_owned());
            return Some(FileChangePayload {
                path: primary_path,
                kind: "rename".to_string(),
                new_path,
            });
        }
        EventKind::Modify(_) => "modify".to_string(),
        // Any event kinds (Access, Other, etc.) — skip
        _ => return None,
    };

    Some(FileChangePayload {
        path: primary_path,
        kind: kind_str,
        new_path: None,
    })
}
