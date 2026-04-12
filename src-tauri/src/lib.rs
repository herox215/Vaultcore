pub mod error;
pub mod commands;
pub mod hash;
pub mod watcher;
pub mod merge;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use notify_debouncer_full::notify::RecommendedWatcher;

/// Write-ignore-list: records own-write events so the file watcher can
/// suppress spurious self-triggered events (D-12).
/// Tokens auto-expire after 500ms to prevent memory leaks.
pub struct WriteIgnoreList {
    entries: HashMap<PathBuf, Instant>,
}

impl Default for WriteIgnoreList {
    fn default() -> Self {
        Self { entries: HashMap::new() }
    }
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
    /// because we wrote it ourselves within the last 100ms.
    pub fn should_ignore(&self, path: &PathBuf) -> bool {
        use std::time::Duration;
        const IGNORE_WINDOW: Duration = Duration::from_millis(100);
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
    pub vault_reachable: Mutex<bool>,
    pub watcher_handle: Arc<Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            current_vault: Mutex::new(None),
            write_ignore: Arc::new(Mutex::new(WriteIgnoreList::default())),
            vault_reachable: Mutex::new(false),
            watcher_handle: Arc::new(Mutex::new(None)),
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
        .invoke_handler(tauri::generate_handler![
            commands::vault::open_vault,
            commands::vault::get_recent_vaults,
            commands::vault::get_vault_stats,
            commands::files::read_file,
            commands::files::write_file,
            commands::files::create_file,
            commands::files::rename_file,
            commands::files::delete_file,
            commands::files::move_file,
            commands::files::create_folder,
            commands::files::count_wiki_links,
            commands::tree::list_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
