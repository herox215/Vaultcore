// Link IPC commands — 6 Tauri commands exposing the LinkGraph to the frontend.
//
// Security:
// - T-04-01: update_links_after_rename applies vault-scope guard
//   (canonicalize + starts_with(vault_root)) before any file read/write.
// - T-04-02: write_ignore records paths before writing in rename-cascade.
//
// Pattern: Clone Arc handles before releasing Mutex (same as search.rs).
// MutexGuard is not Send and cannot be held across await points.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

use crate::error::VaultError;
use crate::indexer::link_graph::{self, BacklinkEntry, ParsedLink, UnresolvedLink};
use crate::commands::search::FileMatch;
use crate::VaultState;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::Utf32Str;
use regex::Regex;

// ── Result types ───────────────────────────────────────────────────────────────

/// Result returned by update_links_after_rename.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub updated_files: usize,
    pub updated_links: usize,
    pub failed_files: Vec<String>,
}

// ── get_backlinks ──────────────────────────────────────────────────────────────

/// Return all backlinks for a vault-relative target path.
///
/// `path` must be vault-relative (e.g. `"folder/Note.md"`).
#[tauri::command]
pub async fn get_backlinks(
    path: String,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<BacklinkEntry>, VaultError> {
    let (lg_arc, fi_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.link_graph(), c.file_index()),
            None => return Ok(Vec::new()),
        }
    };

    let fi = fi_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
    let lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;

    Ok(lg.get_backlinks(&path, &fi))
}

// ── get_outgoing_links ─────────────────────────────────────────────────────────

/// Return all outgoing wiki-links from a vault-relative source path.
#[tauri::command]
pub async fn get_outgoing_links(
    path: String,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<ParsedLink>, VaultError> {
    let lg_arc = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => c.link_graph(),
            None => return Ok(Vec::new()),
        }
    };

    let lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
    Ok(lg.outgoing_for(&path).cloned().unwrap_or_default())
}

// ── get_unresolved_links ───────────────────────────────────────────────────────

/// Return all wiki-links across the vault that could not be resolved.
#[tauri::command]
pub async fn get_unresolved_links(
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<UnresolvedLink>, VaultError> {
    let (lg_arc, fi_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.link_graph(), c.file_index()),
            None => return Ok(Vec::new()),
        }
    };

    let fi = fi_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
    let lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;

    Ok(lg.get_unresolved(&fi.all_relative_paths()))
}

// ── suggest_links ──────────────────────────────────────────────────────────────

/// Fuzzy filename search for `[[` autocomplete — delegates to nucleo matcher.
///
/// Reuses the same FileIndex + Matcher as search_filename (Phase 3).
#[tauri::command]
pub async fn suggest_links(
    query: String,
    limit: usize,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<FileMatch>, VaultError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let effective_limit = if limit == 0 { 20 } else { limit };

    let (fi_arc, matcher_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.file_index(), c.matcher()),
            None => return Ok(Vec::new()),
        }
    };

    let paths: Vec<String> = {
        let fi = fi_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        fi.all_relative_paths()
    };

    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);

    let mut buf: Vec<char> = Vec::new();
    let mut matches: Vec<(String, u32, Vec<u32>)> = {
        let mut matcher = matcher_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        paths
            .into_iter()
            .filter_map(|path| {
                buf.clear();
                let haystack = Utf32Str::new(&path, &mut buf);
                let mut indices: Vec<u32> = Vec::new();
                let score = pattern.indices(haystack, &mut *matcher, &mut indices)?;
                indices.sort_unstable();
                indices.dedup();
                Some((path, score, indices))
            })
            .collect()
    };

    matches.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    matches.truncate(effective_limit);

    Ok(matches
        .into_iter()
        .map(|(path, score, match_indices)| FileMatch { path, score, match_indices })
        .collect())
}

// ── update_links_after_rename ──────────────────────────────────────────────────

/// Rewrite all wiki-links in the vault that point to `old_path` after a rename.
///
/// Security (T-04-01, T-04-02): every target path is canonicalized and checked
/// against vault_root before reading or writing.  write_ignore records each
/// path before writing to suppress the self-triggered watcher event.
///
/// `old_path` and `new_path` are vault-relative.
#[tauri::command]
pub async fn update_links_after_rename(
    old_path: String,
    new_path: String,
    state: tauri::State<'_, VaultState>,
) -> Result<RenameResult, VaultError> {
    // Get vault root — clone before releasing the lock.
    let vault_root: PathBuf = {
        let vp = state.current_vault.lock().map_err(|_| VaultError::VaultUnavailable {
            path: String::new(),
        })?;
        match vp.as_ref() {
            Some(p) => p.clone(),
            None => return Err(VaultError::VaultUnavailable { path: String::from("(none)") }),
        }
    };

    // Extract old stem for regex construction.
    let old_stem = old_path
        .rsplit('/')
        .next()
        .unwrap_or(&old_path)
        .strip_suffix(".md")
        .unwrap_or(&old_path);

    let new_stem = new_path
        .rsplit('/')
        .next()
        .unwrap_or(&new_path)
        .strip_suffix(".md")
        .unwrap_or(&new_path);

    // Regex: [[old_stem]] or [[old_stem|alias]]
    let pattern = format!(r"\[\[{}(\|[^\]]*)?(\]\])", regex::escape(old_stem));
    let re = Regex::new(&pattern).map_err(|e| {
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;

    // Get the list of source files from the link graph's incoming map.
    let sources: Vec<String> = {
        let (lg_arc,) = {
            let guard = state
                .index_coordinator
                .lock()
                .map_err(|_| VaultError::IndexCorrupt)?;
            match guard.as_ref() {
                Some(c) => (c.link_graph(),),
                None => return Ok(RenameResult { updated_files: 0, updated_links: 0, failed_files: vec![] }),
            }
        };
        let lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        lg.incoming_for(&old_path).cloned().unwrap_or_default()
    };

    let mut updated_files = 0usize;
    let mut updated_links = 0usize;
    let mut failed_files: Vec<String> = Vec::new();

    for source_rel in &sources {
        let abs_path = vault_root.join(source_rel);

        // T-04-01: vault-scope guard
        let canonical = match abs_path.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                // Try parent for new files that don't exist yet
                match abs_path.parent().and_then(|p| p.canonicalize().ok()) {
                    Some(parent) if parent.starts_with(&vault_root) => abs_path.clone(),
                    _ => {
                        failed_files.push(source_rel.clone());
                        continue;
                    }
                }
            }
        };
        if !canonical.starts_with(&vault_root) {
            failed_files.push(source_rel.clone());
            continue;
        }

        let content = match std::fs::read_to_string(&abs_path) {
            Ok(c) => c,
            Err(_) => {
                failed_files.push(source_rel.clone());
                continue;
            }
        };

        let mut link_count = 0usize;
        let new_content = re.replace_all(&content, |caps: &regex::Captures| {
            link_count += 1;
            let alias_part = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            format!("[[{}{}]]", new_stem, alias_part)
        }).into_owned();

        if link_count == 0 {
            continue; // Nothing to rewrite in this file
        }

        // T-04-02: record in write_ignore before writing
        {
            let mut ignore = state.write_ignore.lock().map_err(|_| VaultError::IndexCorrupt)?;
            ignore.record(abs_path.clone());
        }

        if let Err(_) = std::fs::write(&abs_path, &new_content) {
            failed_files.push(source_rel.clone());
            continue;
        }

        updated_files += 1;
        updated_links += link_count;
    }

    // Update link graph for each successfully rewritten file.
    let (lg_arc, fi_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.link_graph(), c.file_index()),
            None => return Ok(RenameResult { updated_files, updated_links, failed_files }),
        }
    };

    let all_paths: Vec<String> = {
        let fi = fi_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        fi.all_relative_paths()
    };

    {
        let mut lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        for source_rel in &sources {
            if failed_files.contains(source_rel) {
                continue;
            }
            let abs_path = vault_root.join(source_rel);
            if let Ok(content) = std::fs::read_to_string(&abs_path) {
                let links = link_graph::extract_links(&content);
                lg.update_file(source_rel, links, &all_paths);
            }
        }
        // Also update the renamed file itself in the graph.
        lg.remove_file(&old_path);
        let new_abs = vault_root.join(&new_path);
        if let Ok(content) = std::fs::read_to_string(&new_abs) {
            let links = link_graph::extract_links(&content);
            lg.update_file(&new_path, links, &all_paths);
        }
    }

    Ok(RenameResult { updated_files, updated_links, failed_files })
}

// ── get_resolved_links ─────────────────────────────────────────────────────────

/// Return a stem → vault-relative-path map for all files in the vault.
///
/// Keys are lowercased stems; values are vault-relative paths.
/// The frontend converts this to `Map<string, string>` for zero-IPC click handling.
#[tauri::command]
pub async fn get_resolved_links(
    state: tauri::State<'_, VaultState>,
) -> Result<HashMap<String, String>, VaultError> {
    let fi_arc = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => c.file_index(),
            None => return Ok(HashMap::new()),
        }
    };

    let paths = {
        let fi = fi_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        fi.all_relative_paths()
    };

    Ok(link_graph::resolved_map(&paths))
}
