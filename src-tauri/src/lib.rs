pub mod error;
pub mod commands;
pub mod hash;

#[cfg(test)]
mod tests;

use std::sync::Mutex;

/// Holds the currently-open vault path (canonicalized) so that
/// read_file / write_file can refuse paths outside the vault (T-02).
/// Set by `open_vault`, read by the file commands.
#[derive(Default)]
pub struct VaultState {
    pub current_vault: Mutex<Option<std::path::PathBuf>>,
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
            // files::read_file / files::write_file registered in Task 3
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
