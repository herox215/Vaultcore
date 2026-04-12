//! Tag panel IPC. `list_tags` returns alphabetical TagUsage; `get_tag_occurrences`
//! returns per-file locations for one tag.
//!
//! Pattern: the `let ti = { ... };` block scope drops `coord_guard` before
//! taking the inner `ti.lock()` to avoid holding two locks at once.

use crate::error::VaultError;
use crate::indexer::tag_index::{TagOccurrence, TagUsage};
use crate::VaultState;

fn io_err(msg: &str) -> VaultError {
    VaultError::Io(std::io::Error::other(msg))
}

/// TAG-03: return all tags in the vault sorted alphabetically with usage counts.
#[tauri::command]
pub async fn list_tags(
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<TagUsage>, VaultError> {
    let ti = {
        let coord_guard = state
            .index_coordinator
            .lock()
            .map_err(|_| io_err("coordinator lock poisoned"))?;
        let Some(coord) = coord_guard.as_ref() else {
            return Ok(Vec::new());
        };
        coord.tag_index()
    };
    let guard = ti.lock().map_err(|_| io_err("tag_index lock poisoned"))?;
    Ok(guard.list_tags())
}

/// Return per-file occurrences of a specific tag (case-insensitive).
#[tauri::command]
pub async fn get_tag_occurrences(
    state: tauri::State<'_, VaultState>,
    tag: String,
) -> Result<Vec<TagOccurrence>, VaultError> {
    let ti = {
        let coord_guard = state
            .index_coordinator
            .lock()
            .map_err(|_| io_err("coordinator lock poisoned"))?;
        let Some(coord) = coord_guard.as_ref() else {
            return Ok(Vec::new());
        };
        coord.tag_index()
    };
    let guard = ti.lock().map_err(|_| io_err("tag_index lock poisoned"))?;
    Ok(guard.get_occurrences(&tag))
}
