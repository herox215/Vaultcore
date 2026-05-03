pub mod error;
pub mod commands;
pub mod hash;
pub mod watcher;
pub mod merge;
pub mod indexer;
pub mod encryption;
pub mod storage;
pub mod sync;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use notify_debouncer_full::notify::RecommendedWatcher;

use indexer::memory::FileIndex;
use storage::{VaultHandle, VaultStorage};

/// Write-ignore-list: records own-write events so the file watcher can
/// suppress spurious self-triggered events (D-12).
/// Tokens auto-expire after 500ms to prevent memory leaks.
#[derive(Default)]
pub struct WriteIgnoreList {
    entries: HashMap<PathBuf, Instant>,
}


impl WriteIgnoreList {
    /// Record that we are about to write `path` so the watcher can ignore
    /// the resulting filesystem event.
    pub fn record(&mut self, path: PathBuf) {
        use std::time::Duration;
        const IGNORE_EXPIRY: Duration = Duration::from_millis(500);
        self.entries.retain(|_, t| t.elapsed() < IGNORE_EXPIRY);
        self.entries.insert(path, Instant::now());
    }

    /// Returns `true` if a watcher event for `path` should be suppressed
    /// because we wrote it ourselves recently.  The window must exceed the
    /// notify-debouncer delay (200 ms) so events that arrive after debouncing
    /// are still filtered.  500 ms provides comfortable headroom.
    pub fn should_ignore(&self, path: &PathBuf) -> bool {
        use std::time::Duration;
        const IGNORE_WINDOW: Duration = Duration::from_millis(500);
        self.entries.get(path).map(|t| t.elapsed() < IGNORE_WINDOW).unwrap_or(false)
    }
}

/// Holds the currently-open vault path (canonicalized) so that
/// read_file / write_file can refuse paths outside the vault (T-02).
/// Extended in Phase 2 with write_ignore and vault_reachable fields.
///
/// `watcher_handle` stores the Debouncer from notify-debouncer-full.
/// Wrapped in Arc<Mutex<Option<...>>> so it can be shared across threads
/// and replaced on vault re-open. Debouncer has no Default impl so we
/// use a manual Default that initializes the Option to None.
pub struct VaultState {
    /// #392: VaultHandle wraps a canonicalized POSIX path on desktop and
    /// will gain a `ContentUri(String)` arm in PR-B for Android. Today's
    /// callers use `expect_posix()` (panics on non-POSIX) to access the
    /// inner `&Path`; PR-B migrates each call site to either a storage
    /// trait call or a cfg-gated branch.
    pub current_vault: Mutex<Option<VaultHandle>>,
    /// #392 PR-A: storage abstraction populated by `open_vault`. PR-A
    /// constructs a `PosixStorage` and stashes it here, but no commands
    /// route through the trait yet — the slot exists so PR-B can plug
    /// `AndroidStorage` in without re-wiring `VaultState`.
    pub storage: Arc<RwLock<Option<Arc<dyn VaultStorage>>>>,
    pub write_ignore: Arc<Mutex<WriteIgnoreList>>,
    /// Shared vault reachability flag (ERR-03 / D-14).
    /// Wrapped in Arc so it can be shared with the watcher's reconnect-poll task.
    pub vault_reachable: Arc<Mutex<bool>>,
    pub watcher_handle: Arc<Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>>,
    /// Tantivy IndexCoordinator — created lazily on first open_vault call.
    pub index_coordinator: Arc<Mutex<Option<indexer::IndexCoordinator>>>,
    /// Shared in-memory FileIndex. Owned by `VaultState` so user-initiated
    /// rename/move commands can update it directly — without this, the
    /// watcher's rename event is suppressed by `write_ignore` and the index
    /// never learns about the new rel_path (issue #277). The IndexCoordinator
    /// receives a clone of this Arc on construction so both sides observe
    /// the same map.
    pub file_index: Arc<RwLock<FileIndex>>,

    // #345: per-folder encryption. `locked_paths` is the authoritative
    // gate checked by every FS / indexer / link-graph / search entry.
    // `keyring` caches derived keys for currently-unlocked roots; both
    // clear on vault close and app quit (no persistence of unlocked
    // state across restart).
    pub locked_paths: Arc<encryption::LockedPathRegistry>,
    pub keyring: Arc<encryption::Keyring>,

    // #357: auto-encrypt-on-drop. `pending_queue` holds paths dropped
    // into locked folders (awaiting seal on next unlock). `manifest_cache`
    // memoizes the encrypted-folders manifest so the watcher hot path
    // does not re-read + re-parse JSON for every FS event. Both clear on
    // vault close; the cache is refreshed on every manifest mutation.
    pub pending_queue: Arc<encryption::PendingEncryptionQueue>,
    pub manifest_cache: Arc<encryption::ManifestCache>,
}

impl VaultState {
    /// #392 PR-A: atomically populate `current_vault` and `storage` for a
    /// freshly opened vault. Both fields describe the same vault and PR-B
    /// will read both during file commands; updating them in separate
    /// scopes leaves a window where a concurrent reader sees mismatched
    /// state. A single helper that takes both locks in a deterministic
    /// order is the canonical fix.
    ///
    /// Lock ordering: `current_vault` (Mutex) before `storage` (RwLock).
    /// Used consistently by the only caller (`open_vault`); any future
    /// caller must follow the same order to avoid deadlock.
    pub fn set_open_vault(
        &self,
        handle: storage::VaultHandle,
        store: std::sync::Arc<dyn storage::VaultStorage>,
    ) -> Result<(), error::VaultError> {
        let mut handle_guard = self
            .current_vault
            .lock()
            .map_err(|_| error::VaultError::LockPoisoned)?;
        let mut storage_guard = self
            .storage
            .write()
            .map_err(|_| error::VaultError::LockPoisoned)?;
        *handle_guard = Some(handle);
        *storage_guard = Some(store);
        Ok(())
    }
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            current_vault: Mutex::new(None),
            storage: Arc::new(RwLock::new(None)),
            write_ignore: Arc::new(Mutex::new(WriteIgnoreList::default())),
            vault_reachable: Arc::new(Mutex::new(false)),
            watcher_handle: Arc::new(Mutex::new(None)),
            index_coordinator: Arc::new(Mutex::new(None)),
            file_index: Arc::new(RwLock::new(FileIndex::new())),
            locked_paths: Arc::new(encryption::LockedPathRegistry::new()),
            keyring: Arc::new(encryption::Keyring::new()),
            pending_queue: Arc::new(encryption::PendingEncryptionQueue::new()),
            manifest_cache: Arc::new(encryption::ManifestCache::new()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    env_logger::init();
    #[cfg_attr(not(target_os = "android"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(commands::picker::android_init());
    }
    builder
        .manage(VaultState::default())
        .setup(|app| {
            // #353 one-shot: the removed semantic-search toggle persisted
            // its state in `<app_data_dir>/semantic-enabled.json`. Purge
            // that file on boot so upgraded installs leave no traces.
            // Best-effort — missing file is the common case.
            if let Ok(dir) = app.path().app_data_dir() {
                commands::vault::purge_legacy_semantic_toggle_file(&dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::open_vault,
            commands::vault::get_recent_vaults,
            commands::vault::get_vault_stats,
            commands::vault::repair_vault_index,
            commands::files::read_file,
            commands::files::write_file,
            commands::files::create_file,
            commands::files::rename_file,
            commands::files::delete_file,
            commands::files::move_file,
            commands::files::create_folder,
            commands::files::count_wiki_links,
            commands::files::get_file_hash,
            commands::files::save_attachment,
            commands::files::read_attachment_bytes,
            commands::tree::list_directory,
            commands::vault::merge_external_change,
            commands::search::search_fulltext,
            commands::search::search_filename,
            commands::search::rebuild_index,
            commands::links::get_backlinks,
            commands::links::get_outgoing_links,
            commands::links::get_unresolved_links,
            commands::links::suggest_links,
            commands::links::update_links_after_rename,
            commands::links::get_resolved_links,
            commands::links::get_resolved_anchors,
            commands::links::get_resolved_attachments,
            commands::links::get_local_graph,
            commands::links::get_link_graph,
            commands::tags::list_tags,
            commands::tags::get_tag_occurrences,
            commands::bookmarks::load_bookmarks,
            commands::bookmarks::save_bookmarks,
            commands::snippets::list_snippets,
            commands::snippets::read_snippet,
            commands::templates::list_templates,
            commands::templates::read_template,
            commands::export::export_note_html,
            commands::export::render_note_html,
            commands::encryption::encrypt_folder,
            commands::encryption::unlock_folder,
            commands::encryption::lock_folder,
            commands::encryption::lock_all_folders,
            commands::encryption::list_encrypted_folders,
            commands::encryption::export_decrypted_file,
            commands::picker::pick_vault_folder,
            commands::picker::pick_save_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
