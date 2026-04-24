//! File watcher module — spawns notify-debouncer-full on vault open.
//!
//! Responsibilities:
//! - Spawn a recursive watcher over the vault directory using notify-debouncer-full
//! - Filter self-writes via WriteIgnoreList (D-12)
//! - Filter dot-prefixed directory components (.obsidian/, .trash/, .git/, etc.)
//! - Detect bulk-change bursts (>500 events) and switch to progress UI mode (D-13)
//! - #357: auto-encrypt files dropped into unlocked encrypted folders;
//!   enqueue drops into locked folders for seal-on-unlock.
//! - Emit typed Tauri events: vault://file_changed, vault://bulk_change_start,
//!   vault://bulk_change_end, vault://watcher_error, vault://vault_status,
//!   vault://encrypt_drop_progress.

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
use tokio::time::sleep;

use crate::WriteIgnoreList;
use crate::encryption::{
    encrypt_file_in_place_if_needed, CanonicalPath, EncryptDeps, EncryptOutcome, Keyring,
    LockedPathRegistry, ManifestCache, PendingEncryptionQueue,
};
use crate::indexer::IndexCmd;

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

pub const FILE_CHANGED_EVENT: &str = "vault://file_changed";
const BULK_CHANGE_START_EVENT: &str = "vault://bulk_change_start";
const BULK_CHANGE_END_EVENT: &str = "vault://bulk_change_end";
const VAULT_STATUS_EVENT: &str = "vault://vault_status";
const WATCHER_ERROR_EVENT: &str = "vault://watcher_error";
/// #357 — same event name the IPC unlock path emits, kept as a
/// module-local constant so `process_events` does not take a runtime
/// dependency on `commands::encryption`.
const ENCRYPT_DROP_PROGRESS_EVENT: &str = "vault://encrypt_drop_progress";

// ─── Public API ───────────────────────────────────────────────────────────────

/// Interval for the vault-reachability reconnect poll (ERR-03 / D-14).
const RECONNECT_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Spawn a recursive file watcher over `vault_path`.
///
/// Returns a `Debouncer` handle that MUST be kept alive in `VaultState` for
/// the watcher to remain active. Dropping it stops the watcher.
///
/// Events are debounced at 200ms, self-writes filtered via `write_ignore`,
/// and dot-prefixed paths filtered before emission.
///
/// Also spawns a background tokio task that polls every 5 seconds when the
/// vault is unreachable, emitting `vault://vault_status { reachable: true }`
/// once it can be reached again (ERR-03 / D-14).
/// Spawn a recursive file watcher over `vault_path`.
///
/// `index_tx`: optional mpsc sender to the IndexCoordinator queue.  When
/// provided, create/modify events dispatch `IndexCmd::UpdateLinks` and delete
/// events dispatch `IndexCmd::RemoveLinks` for incremental link-graph updates
/// (LINK-08). The same write-ignore suppression that applies to Tauri events
/// applies here — if a path is in write_ignore, both the Tauri event and the
/// link-graph command are skipped.
/// #357 — bundle of shared refs the watcher needs beyond the write
/// ignore list + vault path. A struct keeps `spawn_watcher` at a
/// manageable arity instead of bolting on another `Arc<...>` parameter
/// for each new concern.
pub struct WatcherContext {
    pub locked_paths: Arc<LockedPathRegistry>,
    pub keyring: Arc<Keyring>,
    pub pending_queue: Arc<PendingEncryptionQueue>,
    pub manifest_cache: Arc<ManifestCache>,
}

pub fn spawn_watcher(
    app: AppHandle,
    vault_path: PathBuf,
    write_ignore: Arc<Mutex<WriteIgnoreList>>,
    vault_reachable: Arc<Mutex<bool>>,
    index_tx: Option<tokio::sync::mpsc::Sender<IndexCmd>>,
    ctx: WatcherContext,
) -> Debouncer<RecommendedWatcher, RecommendedCache> {
    let vault_path_clone = vault_path.clone();
    let vault_reachable_for_error = vault_reachable.clone();
    let app_for_error = app.clone();
    let app_for_events = app.clone();
    let locked_paths_for_events = Arc::clone(&ctx.locked_paths);
    let keyring_for_events = Arc::clone(&ctx.keyring);
    let pending_queue_for_events = Arc::clone(&ctx.pending_queue);
    let manifest_cache_for_events = Arc::clone(&ctx.manifest_cache);

    let mut debouncer = new_debouncer(
        DEBOUNCE_DURATION,
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                process_events(
                    &app_for_events,
                    &write_ignore,
                    &vault_path_clone,
                    &index_tx,
                    &locked_paths_for_events,
                    &keyring_for_events,
                    &pending_queue_for_events,
                    &manifest_cache_for_events,
                    events,
                );
            }
            Err(errors) => {
                for error in errors {
                    // Check if this is a path-not-found error on the vault root,
                    // which indicates the vault has been unmounted (ERR-03).
                    let is_vault_missing = error.paths.iter().any(|p| p == &vault_path_clone)
                        || format!("{:?}", error.kind).contains("NotFound");

                    if is_vault_missing {
                        // Mark vault unreachable in shared state
                        if let Ok(mut reachable) = vault_reachable_for_error.lock() {
                            *reachable = false;
                        }
                        let _ = app_for_error.emit(
                            VAULT_STATUS_EVENT,
                            VaultStatusPayload { reachable: false },
                        );
                    }

                    let _ = app_for_error.emit(
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

    // Spawn a background task that polls vault reachability every 5 seconds
    // when vault_reachable is false (ERR-03 / D-14).
    let app_poll = app.clone();
    let vault_path_poll = vault_path.clone();
    let vault_reachable_poll = vault_reachable.clone();
    tokio::spawn(async move {
        loop {
            sleep(RECONNECT_POLL_INTERVAL).await;

            // Only poll when vault is known unreachable
            let is_unreachable = vault_reachable_poll
                .lock()
                .map(|g| !*g)
                .unwrap_or(false);

            if is_unreachable && vault_path_poll.exists() {
                // Vault is reachable again
                if let Ok(mut reachable) = vault_reachable_poll.lock() {
                    *reachable = true;
                }
                let _ = app_poll.emit(
                    VAULT_STATUS_EVENT,
                    VaultStatusPayload { reachable: true },
                );
            }
        }
    });

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
/// 1b. Partition into locked vs unlocked — locked events enqueue their
///     primary path for seal-on-unlock (#357) and never reach the
///     indexer dispatchers. Both paths[0] and paths[1] are checked so a
///     rename that spans the locked boundary can't leak secondaries.
/// 1c. (#357) For the UNLOCKED partition, run the auto-encrypt
///     orchestrator on Create / Modify events. Sealed files have their
///     post-seal write recorded in write_ignore to prevent self-loops.
/// 2. Filter self-writes via write_ignore list (D-12), matching against
///    every path in the event (not just primary) so rename events
///    carrying the sealed target at paths[1] are also suppressed.
/// 3. Check bulk-change threshold (D-13)
/// 4. Emit typed Tauri events
/// 5. Dispatch link-graph commands to IndexCoordinator queue (LINK-08)
#[allow(clippy::too_many_arguments)]
fn process_events(
    app: &AppHandle,
    write_ignore: &Arc<Mutex<WriteIgnoreList>>,
    vault_path: &Path,
    index_tx: &Option<tokio::sync::mpsc::Sender<IndexCmd>>,
    locked_paths: &Arc<LockedPathRegistry>,
    keyring: &Arc<Keyring>,
    pending_queue: &Arc<PendingEncryptionQueue>,
    manifest_cache: &Arc<ManifestCache>,
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

    // Step 1b (#345 + #357): partition into locked vs unlocked. Locked
    // events enqueue their path for seal-on-unlock and are DROPPED from
    // further processing — the indexer must not learn about files it
    // cannot read. Unlocked events continue down the pipeline.
    let (locked_events, filtered): (Vec<DebouncedEvent>, Vec<DebouncedEvent>) =
        filtered.into_iter().partition(|ev| {
            ev.paths.iter().take(2).any(|p| {
                let canon = CanonicalPath::assume_canonical(p.clone());
                locked_paths.is_locked(&canon)
            })
        });
    if !locked_events.is_empty() {
        handle_locked_drops(app, manifest_cache, pending_queue, &locked_events);
    }

    // Step 1c (#357): on unlocked events, run the auto-encrypt
    // orchestrator for Create and data-Modify events. This is what
    // closes the "Finder dropped a binary into my encrypted folder"
    // hole. Errors surface as progress-event toasts; the event still
    // propagates to the indexer so Tantivy/link-graph stay in sync.
    let mut progress = EncryptDropRunState::default();
    for ev in &filtered {
        if !should_run_orchestrator(ev) {
            continue;
        }
        let Some(primary) = ev.paths.first() else { continue };
        let canonical = match std::fs::canonicalize(primary) {
            Ok(c) => c,
            Err(_) => continue, // path vanished between event + canonicalize
        };
        let deps = EncryptDeps {
            vault_root: vault_path,
            locked_paths,
            keyring,
            pending_queue,
            write_ignore,
            manifest_cache,
        };
        match encrypt_file_in_place_if_needed(&deps, &canonical) {
            Ok(EncryptOutcome::Sealed { .. }) => {
                progress.total += 1;
                progress.last_completed = Some(canonical.display().to_string());
            }
            Ok(EncryptOutcome::Queued { .. }) | Ok(EncryptOutcome::AlreadySealed) |
            Ok(EncryptOutcome::NotInEncryptedRoot) | Ok(EncryptOutcome::NotRegularFile) => {}
            Err(e) => {
                log::warn!(
                    "auto-encrypt on drop failed for {}: {e:?}",
                    canonical.display()
                );
                let _ = app.emit(
                    ENCRYPT_DROP_PROGRESS_EVENT,
                    serde_json::json!({
                        "inFlight": 0,
                        "total": 0,
                        "lastCompleted": null,
                        "queued": false,
                        "error": {
                            "path": canonical.display().to_string(),
                            "message": e.to_string(),
                        }
                    }),
                );
            }
        }
    }
    if progress.total > 0 {
        let _ = app.emit(
            ENCRYPT_DROP_PROGRESS_EVENT,
            serde_json::json!({
                "inFlight": 0,
                "total": progress.total,
                "lastCompleted": progress.last_completed,
                "queued": false,
                "error": null
            }),
        );
    }

    // Step 2: Filter self-writes via write_ignore. #357 — check EVERY
    // path on the event, not just `paths[0]`. A rename event from the
    // atomic write carries the sealed target at `paths[1]` on Linux
    // inotify and the sealed target at `paths[0]` on some platforms;
    // matching against all paths covers every observed backend.
    let filtered: Vec<DebouncedEvent> = {
        let ignore = write_ignore.lock().unwrap_or_else(|e| e.into_inner());
        filtered
            .into_iter()
            .filter(|ev| !ev.paths.iter().any(|p| ignore.should_ignore(p)))
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

    // Step 4: Emit individual file_changed events and dispatch index commands
    for ev in filtered {
        // Step 5: Dispatch link-graph + tag-index commands (LINK-08, TAG-01/02).
        //
        // #246: read the .md body exactly once per event and hand it to both
        // dispatchers. Previously each dispatcher did its own
        // std::fs::read_to_string, doubling syscalls + transient allocations
        // on the bulk-save hot path. Both dispatchers are pure functions of
        // (rel_path, content), so sharing the read is also strictly more
        // consistent (no risk of the file changing between the two reads).
        if let Some(tx) = index_tx {
            let (primary_content, renamed_content) = read_event_contents(vault_path, &ev);
            dispatch_link_graph_cmd(
                tx,
                vault_path,
                &ev,
                primary_content.as_deref(),
                renamed_content.as_deref(),
            );
            dispatch_tag_index_cmd(
                tx,
                vault_path,
                &ev,
                primary_content.as_deref(),
                renamed_content.as_deref(),
            );
        }

        if let Some(payload) = map_event_to_payload(vault_path, &ev) {
            let _ = app.emit(FILE_CHANGED_EVENT, payload);
        }
    }

    // Step 3 (continued): Emit bulk_change_end after processing all events
    if count > BULK_THRESHOLD {
        let _ = app.emit(BULK_CHANGE_END_EVENT, serde_json::json!({}));
    }
}

/// Describe an `IndexCmd` briefly for overflow logs without including
/// file content (watchers see raw document bodies — keep them out of logs).
fn cmd_kind(cmd: &IndexCmd) -> &'static str {
    match cmd {
        IndexCmd::AddFile { .. } => "AddFile",
        IndexCmd::DeleteFile { .. } => "DeleteFile",
        IndexCmd::DeleteAll => "DeleteAll",
        IndexCmd::Commit => "Commit",
        IndexCmd::Rebuild { .. } => "Rebuild",
        IndexCmd::UpdateLinks { .. } => "UpdateLinks",
        IndexCmd::RemoveLinks { .. } => "RemoveLinks",
        IndexCmd::UpdateTags { .. } => "UpdateTags",
        IndexCmd::RemoveTags { .. } => "RemoveTags",
        IndexCmd::Shutdown => "Shutdown",
    }
}

/// Try to enqueue `cmd`, logging a warning on overflow or closure.
///
/// Issue #139: the previous `let _ = tx.try_send(...)` lines silently
/// dropped commands when the 1024-slot channel filled up during bulk
/// events. The symptom (stale link-graph / tag-index) only surfaced on
/// the next full rebuild. This helper makes the overflow observable so a
/// user report like "backlinks panel lost entries after I ran git pull"
/// becomes grep-able in the log.
pub(crate) fn try_send_or_warn(tx: &tokio::sync::mpsc::Sender<IndexCmd>, cmd: IndexCmd) {
    let kind = cmd_kind(&cmd);
    match tx.try_send(cmd) {
        Ok(()) => {}
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            log::warn!(
                "IndexCmd channel full (capacity {}) — dropping {} event. \
                A bulk operation is outrunning the indexer; \
                link/tag state may be stale until the next edit or rebuild.",
                crate::indexer::CHANNEL_CAPACITY,
                kind,
            );
        }
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
            log::debug!(
                "IndexCmd channel closed when dispatching {} — \
                coordinator was dropped (probably vault switch in progress).",
                kind,
            );
        }
    }
}

/// Read the event's primary path (and renamed path, for rename events) from
/// disk exactly once so both downstream dispatchers can share the same body.
///
/// #246 — previously each dispatcher did its own `std::fs::read_to_string`,
/// so a single `.md` modify event hit disk twice and allocated two Strings.
/// Now `process_events` reads once and hands the content to both dispatchers.
///
/// Returns `(primary_content, renamed_content)`:
/// - `primary_content` is `Some` for Create / non-rename Modify on an in-vault
///   `.md` path whose bytes could be read. `None` otherwise (Remove, rename,
///   non-.md, out-of-vault, or read failure).
/// - `renamed_content` is `Some` only for rename events (`ModifyKind::Name`)
///   where `paths[1]` is an in-vault `.md` file whose bytes could be read.
fn read_event_contents(
    vault_path: &Path,
    ev: &DebouncedEvent,
) -> (Option<String>, Option<String>) {
    let primary_path = match ev.paths.first() {
        Some(p) => p,
        None => return (None, None),
    };

    let is_md = |p: &Path| {
        p.extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    };
    let in_vault = |p: &Path| p.starts_with(vault_path);

    match &ev.kind {
        EventKind::Modify(ModifyKind::Name(_)) => {
            // Rename: only the NEW path (paths[1]) carries fresh content.
            let renamed = ev.paths.get(1).and_then(|new_path| {
                if is_md(new_path) && in_vault(new_path) {
                    std::fs::read_to_string(new_path).ok()
                } else {
                    None
                }
            });
            (None, renamed)
        }
        EventKind::Create(_) | EventKind::Modify(_) => {
            let primary = if is_md(primary_path) && in_vault(primary_path) {
                std::fs::read_to_string(primary_path).ok()
            } else {
                None
            };
            (primary, None)
        }
        // Remove / Access / Other — neither dispatcher needs on-disk content.
        _ => (None, None),
    }
}

/// Dispatch `IndexCmd::UpdateLinks` or `IndexCmd::RemoveLinks` based on the
/// event kind.  Only `.md` files are dispatched — non-Markdown file changes
/// don't affect the link graph.
///
/// #246: `primary_content` / `renamed_content` are pre-read by
/// `read_event_contents` so this dispatcher never touches disk. Both
/// dispatchers share the same bytes, halving syscalls on the watcher hot
/// path during bulk saves.
///
/// Uses `try_send_or_warn` so a full channel drops the command rather than
/// blocking the watcher callback thread, but logs the drop (#139).
pub(crate) fn dispatch_link_graph_cmd(
    tx: &tokio::sync::mpsc::Sender<IndexCmd>,
    vault_path: &Path,
    ev: &DebouncedEvent,
    primary_content: Option<&str>,
    renamed_content: Option<&str>,
) {
    let primary_path = match ev.paths.first() {
        Some(p) => p,
        None => return,
    };

    // Only handle .md files
    if primary_path.extension().map_or(true, |ext| !ext.eq_ignore_ascii_case("md")) {
        return;
    }

    // Compute vault-relative path
    let rel_path = match primary_path.strip_prefix(vault_path) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => return,
    };

    match &ev.kind {
        EventKind::Create(_) | EventKind::Modify(_) => {
            // For rename events, the new path is paths[1]; dispatch UpdateLinks for both
            // old (RemoveLinks) and new (UpdateLinks).
            if let EventKind::Modify(notify_debouncer_full::notify::event::ModifyKind::Name(_)) = &ev.kind {
                // Old path → RemoveLinks
                try_send_or_warn(tx, IndexCmd::RemoveLinks { rel_path: rel_path.clone() });
                // New path → UpdateLinks (if paths[1] exists and is .md)
                if let Some(new_path) = ev.paths.get(1) {
                    if new_path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) {
                        let new_rel = match new_path.strip_prefix(vault_path) {
                            Ok(r) => r.to_string_lossy().replace('\\', "/"),
                            Err(_) => return,
                        };
                        if let Some(content) = renamed_content {
                            try_send_or_warn(tx, IndexCmd::UpdateLinks {
                                rel_path: new_rel,
                                content: content.to_owned(),
                            });
                        }
                    }
                }
            } else {
                // create or modify — use the pre-read content
                if let Some(content) = primary_content {
                    try_send_or_warn(tx, IndexCmd::UpdateLinks {
                        rel_path,
                        content: content.to_owned(),
                    });
                }
            }
        }
        EventKind::Remove(_) => {
            try_send_or_warn(tx, IndexCmd::RemoveLinks { rel_path });
        }
        _ => {}
    }
}

/// Dispatch `IndexCmd::UpdateTags` or `IndexCmd::RemoveTags` based on the
/// event kind. Only `.md` files are dispatched — non-Markdown file changes
/// don't affect the tag index.
///
/// #246: `primary_content` / `renamed_content` are pre-read by
/// `read_event_contents` so this dispatcher never touches disk. Shares the
/// same bytes with `dispatch_link_graph_cmd`, halving the watcher's syscall
/// and allocation cost per event.
///
/// Uses `try_send_or_warn` so a full channel drops the command rather than
/// blocking the watcher callback thread, but logs the drop (#139).
pub(crate) fn dispatch_tag_index_cmd(
    tx: &tokio::sync::mpsc::Sender<IndexCmd>,
    vault_path: &Path,
    ev: &DebouncedEvent,
    primary_content: Option<&str>,
    renamed_content: Option<&str>,
) {
    let primary_path = match ev.paths.first() {
        Some(p) => p,
        None => return,
    };

    // Only handle .md files
    if primary_path
        .extension()
        .map_or(true, |ext| !ext.eq_ignore_ascii_case("md"))
    {
        return;
    }

    // Compute vault-relative path
    let rel_path = match primary_path.strip_prefix(vault_path) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => return,
    };

    match &ev.kind {
        EventKind::Create(_) | EventKind::Modify(_) => {
            if let EventKind::Modify(
                notify_debouncer_full::notify::event::ModifyKind::Name(_),
            ) = &ev.kind
            {
                // Old path → RemoveTags
                try_send_or_warn(tx, IndexCmd::RemoveTags {
                    rel_path: rel_path.clone(),
                });
                // New path → UpdateTags (if paths[1] exists and is .md)
                if let Some(new_path) = ev.paths.get(1) {
                    if new_path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                    {
                        let new_rel = match new_path.strip_prefix(vault_path) {
                            Ok(r) => r.to_string_lossy().replace('\\', "/"),
                            Err(_) => return,
                        };
                        if let Some(content) = renamed_content {
                            try_send_or_warn(tx, IndexCmd::UpdateTags {
                                rel_path: new_rel,
                                content: content.to_owned(),
                            });
                        }
                    }
                }
            } else {
                // create or modify — use the pre-read content
                if let Some(content) = primary_content {
                    try_send_or_warn(tx, IndexCmd::UpdateTags {
                        rel_path,
                        content: content.to_owned(),
                    });
                }
            }
        }
        EventKind::Remove(_) => {
            try_send_or_warn(tx, IndexCmd::RemoveTags { rel_path });
        }
        _ => {}
    }
}

/// #357 — running totals for encrypt-on-drop progress emission within
/// one `process_events` batch. `in_flight` is always 0 at the point the
/// progress event fires because the orchestrator is synchronous — we
/// only emit after the batch finishes. Kept as a struct so future
/// async progress (streaming encrypts) can populate `in_flight`.
#[derive(Default)]
struct EncryptDropRunState {
    total: usize,
    last_completed: Option<String>,
}

/// #357 — only Create and data-Modify events can possibly contain a
/// newly-arrived plaintext file. Remove/Access/Other never do. Rename
/// events are a special case: the new path (paths[1]) is what needs
/// sealing, but notify's rename semantics vary enough across platforms
/// that running the orchestrator on the Create that follows is simpler
/// and semantically equivalent.
fn should_run_orchestrator(ev: &DebouncedEvent) -> bool {
    matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(ModifyKind::Data(_)))
}

/// #357 — handle the locked partition: for every Create/Modify event
/// on a regular file inside a currently-locked encrypted root, enqueue
/// the path for seal-on-unlock and emit a `queued` progress event so
/// the UI can warn the user.
fn handle_locked_drops(
    app: &AppHandle,
    manifest_cache: &Arc<ManifestCache>,
    pending_queue: &Arc<PendingEncryptionQueue>,
    events: &[DebouncedEvent],
) {
    for ev in events {
        if !should_run_orchestrator(ev) {
            continue;
        }
        let Some(primary) = ev.paths.first() else { continue };
        let canonical = match std::fs::canonicalize(primary) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let meta = match std::fs::metadata(&canonical) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        // Resolve the enclosing encrypted root via the cache.
        let Ok(Some(root)) = manifest_cache.find_enclosing(&canonical) else {
            continue;
        };
        if let Err(e) = pending_queue.enqueue_for_root(root, canonical.clone()) {
            log::warn!(
                "enqueue for seal-on-unlock failed for {}: {e:?}",
                canonical.display()
            );
            continue;
        }
        let _ = app.emit(
            ENCRYPT_DROP_PROGRESS_EVENT,
            serde_json::json!({
                "inFlight": 0,
                "total": 0,
                "lastCompleted": canonical.display().to_string(),
                "queued": true,
                "error": null,
            }),
        );
        // Diagnostic: the file is on disk as plaintext until next unlock.
        log::info!(
            "queued for seal-on-unlock: {} — plaintext remains on disk until user unlocks",
            canonical.display()
        );
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
