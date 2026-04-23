pub mod error;
pub mod commands;
pub mod hash;
pub mod watcher;
pub mod merge;
pub mod indexer;
pub mod encryption;

#[cfg(feature = "embeddings")]
pub mod embeddings;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use notify_debouncer_full::notify::RecommendedWatcher;

use indexer::memory::FileIndex;

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
    pub current_vault: Mutex<Option<std::path::PathBuf>>,
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
    /// Embed-on-save coordinator (#196). `None` when the embeddings
    /// feature is off, the model isn't bundled, or ORT init failed.
    /// `write_file` skips the embed dispatch silently in that case.
    #[cfg(feature = "embeddings")]
    pub embed_coordinator: Arc<Mutex<Option<embeddings::EmbedCoordinator>>>,
    /// Running reindex worker (#201 PR-B), if any. The `reindex_vault`
    /// command cancels the previous handle before spawning a new one,
    /// and `open_vault` cancels on vault switch so the old worker can't
    /// write to the freshly-replaced coordinator's checkpoint.
    #[cfg(feature = "embeddings")]
    pub reindex_handle: Arc<Mutex<Option<Arc<embeddings::ReindexHandle>>>>,
    /// Embed service + HNSW sink pair (#202) used by the `semantic_search`
    /// IPC command. The sink Arc here aliases the one held by
    /// `embed_coordinator` (upcast as `Arc<dyn VectorSink>`), so queries
    /// see the same live `VectorIndex` the embed worker writes to.
    #[cfg(feature = "embeddings")]
    pub query_handles: Arc<Mutex<Option<Arc<embeddings::QueryHandles>>>>,

    // #345: per-folder encryption. `locked_paths` is the authoritative
    // gate checked by every FS / indexer / link-graph / search entry.
    // `keyring` caches derived keys for currently-unlocked roots; both
    // clear on vault close and app quit (no persistence of unlocked
    // state across restart).
    pub locked_paths: Arc<encryption::LockedPathRegistry>,
    pub keyring: Arc<encryption::Keyring>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            current_vault: Mutex::new(None),
            write_ignore: Arc::new(Mutex::new(WriteIgnoreList::default())),
            vault_reachable: Arc::new(Mutex::new(false)),
            watcher_handle: Arc::new(Mutex::new(None)),
            index_coordinator: Arc::new(Mutex::new(None)),
            file_index: Arc::new(RwLock::new(FileIndex::new())),
            #[cfg(feature = "embeddings")]
            embed_coordinator: Arc::new(Mutex::new(None)),
            #[cfg(feature = "embeddings")]
            reindex_handle: Arc::new(Mutex::new(None)),
            #[cfg(feature = "embeddings")]
            query_handles: Arc::new(Mutex::new(None)),
            locked_paths: Arc::new(encryption::LockedPathRegistry::new()),
            keyring: Arc::new(encryption::Keyring::new()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(VaultState::default())
        .setup(|_app| {
            #[cfg(feature = "embeddings")]
            {
                // #244: honour the semantic-search toggle on startup. When
                // off, skip the ORT init entirely — the runtime dylib
                // mapping itself is deferred until the user flips the
                // toggle on and `set_semantic_enabled` runs lazy init.
                if commands::vault::read_semantic_enabled(&_app.handle()) {
                    if let Err(e) = embeddings::bootstrap(&_app.handle()) {
                        log::warn!("embeddings bootstrap failed: {e}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::open_vault,
            commands::vault::get_recent_vaults,
            commands::vault::get_vault_stats,
            commands::vault::repair_vault_index,
            #[cfg(feature = "embeddings")]
            commands::vault::reindex_vault,
            #[cfg(feature = "embeddings")]
            commands::vault::cancel_reindex,
            commands::vault::set_semantic_enabled,
            commands::vault::refresh_all_embeddings,
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
            commands::tree::list_directory,
            commands::vault::merge_external_change,
            commands::search::search_fulltext,
            commands::search::search_filename,
            commands::search::semantic_search,
            commands::search::hybrid_search,
            commands::search::rebuild_index,
            commands::links::get_backlinks,
            commands::links::get_outgoing_links,
            commands::links::get_unresolved_links,
            commands::links::suggest_links,
            commands::links::update_links_after_rename,
            commands::links::get_resolved_links,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
