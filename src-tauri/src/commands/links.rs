// Link IPC commands — 6 Tauri commands exposing the LinkGraph to the frontend.
//
// Security:
// - T-04-01: update_links_after_rename applies vault-scope guard
//   (canonicalize + starts_with(vault_root)) before any file read/write.
// - T-04-02: write_ignore records paths before writing in rename-cascade.
//
// Pattern: Clone Arc handles before releasing Mutex (same as search.rs).
// MutexGuard is not Send and cannot be held across await points.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;

use serde::Serialize;

use crate::encryption::CanonicalPath;
use crate::error::VaultError;
use crate::indexer::anchors::AnchorKeySet;
use crate::indexer::link_graph::{self, BacklinkEntry, LinkGraph, ParsedLink, UnresolvedLink};
use crate::indexer::memory::FileIndex;
use crate::indexer::tag_index::TagIndex;
use crate::commands::search::FileMatch;
use crate::VaultState;

/// #345: check whether a vault-relative forward-slash path resolves
/// into a currently-locked encrypted root. Returns `true` when the path
/// is locked (callers then filter/drop it) or when the vault is not
/// open (fail-closed on an ambiguous state — the alternative would be
/// to leak a locked-folder reference on a startup race).
///
/// Intended for low-cardinality call sites (one path per IPC). Bulk
/// filters over `FileIndex::all_relative_paths()` should go through
/// `LockedRelChecker` instead — it precomputes the locked roots as
/// forward-slash vault-relative prefixes and short-circuits on the
/// empty-registry case, so the hot path stays well under the per-
/// keystroke budget at 100k-note scale.
fn is_rel_path_locked(state: &VaultState, rel: &str) -> bool {
    LockedRelChecker::new(state).is_locked(rel)
}

/// Precomputed view of the locked-paths registry for bulk filtering in
/// link / backlink / graph pipelines.
///
/// Holds vault-relative, forward-slash, lowercased-on-case-insensitive
/// prefixes of every currently-locked encrypted root. `is_locked(rel)`
/// does one vec-scan per path — O(k) where k = number of encrypted
/// roots, which in practice is 0-5. The empty-registry case (very
/// common) short-circuits to `false` without any allocation or syscall.
struct LockedRelChecker {
    prefixes: Vec<String>,
}

impl LockedRelChecker {
    fn new(state: &VaultState) -> Self {
        let snapshot = state.locked_paths.snapshot().unwrap_or_default();
        if snapshot.is_empty() {
            return Self { prefixes: Vec::new() };
        }
        let vault: Option<std::path::PathBuf> = match state.current_vault.lock() {
            Ok(g) => g.as_ref().map(|h| h.expect_posix().to_path_buf()),
            Err(_) => None,
        };
        let Some(vault_root) = vault else {
            // Vault closed race: fail closed on every call.
            return Self {
                prefixes: vec![String::from("")],
            };
        };
        let prefixes = snapshot
            .into_iter()
            .filter_map(|root| {
                root.strip_prefix(&vault_root)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
            })
            .collect();
        Self { prefixes }
    }

    fn is_locked(&self, rel: &str) -> bool {
        if self.prefixes.is_empty() {
            return false;
        }
        self.prefixes.iter().any(|root| {
            rel == root
                || rel
                    .strip_prefix(root)
                    .is_some_and(|tail| tail.starts_with('/'))
        })
    }
}

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::Utf32Str;
use rayon::prelude::*;
use regex::Regex;
use walkdir::WalkDir;

/// Image extensions whose files are exposed as wiki-embed targets
/// (`![[image.png]]`). Everything else is ignored during the walk.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Directories skipped by the attachment walk. `.md` files are excluded
/// separately since they're already covered by `get_resolved_links`.
const SKIP_DIRS: &[&str] = &[".obsidian", ".git", ".vaultcore", ".trash", "templates"];

// ── Result types ───────────────────────────────────────────────────────────────

/// Result returned by update_links_after_rename.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub updated_files: usize,
    pub updated_links: usize,
    pub failed_files: Vec<String>,
    /// Vault-relative paths of files whose content was rewritten. The frontend
    /// uses this to reload any open tabs pointing at these files so the CM6
    /// EditorView content stays in sync with the on-disk update.
    pub updated_paths: Vec<String>,
}

// ── rewrite_wiki_links_respecting_templates ────────────────────────────────────

/// Rewrite `[[old_stem]]` / `[[old_stem|alias]]` occurrences in `content` to
/// use `new_stem`, EXCEPT those that fall inside a `{{ ... }}` template body.
///
/// Returns `(rewritten_content, rewrite_count)`. A count of 0 means the file
/// touched no rewritable links — either there were none, or every occurrence
/// lived inside a template body and was preserved verbatim.
///
/// Template-body preservation is the #330 follow-up (#331 review): a user
/// renaming `foo` → `bar` must not corrupt a template reading
/// `vault.notes.where(n => n.name == "foo")`, which would silently start
/// saying "bar" on the next render. `extract_links` (the read path) already
/// skips template bodies; this keeps the disk-writing rename path aligned
/// with the graph it feeds so the two halves of the rename flow stay
/// internally consistent.
///
/// `re` MUST be the pre-compiled rename regex
/// (`\[\[<old_stem>(#[^\]\|\^]+)?(\^[A-Za-z0-9-]+)?(\|[^\]]*)?(\]\])`).
/// Compilation is hoisted to the caller so the `rayon` parallel loop
/// reuses a single instance.
///
/// #62: heading (`#H`) and block-id (`^id`) suffixes are preserved
/// unchanged so a rename of `Note` → `NewNote` rewrites `[[Note#H]]` →
/// `[[NewNote#H]]` and `[[Note^id]]` → `[[NewNote^id]]` instead of
/// collapsing them to `[[NewNote]]` (which would silently drop the anchor
/// and route every cascade'd link to the top of the renamed note).
fn rewrite_wiki_links_respecting_templates(
    content: &str,
    re: &Regex,
    new_stem: &str,
) -> (String, usize) {
    let template_ranges = link_graph::template_expr_ranges(content);
    let mut link_count = 0usize;
    let new_content = re
        .replace_all(content, |caps: &regex::Captures| {
            let whole = caps.get(0).expect("capture 0 always present");
            if link_graph::overlaps_any(&template_ranges, whole.start(), whole.end()) {
                return whole.as_str().to_string();
            }
            link_count += 1;
            let heading_part = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let block_part = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let alias_part = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            format!("[[{}{}{}{}]]", new_stem, heading_part, block_part, alias_part)
        })
        .into_owned();
    (new_content, link_count)
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
    // #345: if the target itself is locked, backlinks must not leak.
    if is_rel_path_locked(&state, &path) {
        return Ok(Vec::new());
    }
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

    let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
    let lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;

    // #345: drop backlink rows whose source lives inside a locked root.
    let raw = lg.get_backlinks(&path, &fi);
    drop(lg);
    drop(fi);
    Ok(raw
        .into_iter()
        .filter(|b| !is_rel_path_locked(&state, &b.source_path))
        .collect())
}

// ── get_outgoing_links ─────────────────────────────────────────────────────────

/// Return all outgoing wiki-links from a vault-relative source path.
#[tauri::command]
pub async fn get_outgoing_links(
    path: String,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<ParsedLink>, VaultError> {
    // #345: a locked source's outgoing links are opaque.
    if is_rel_path_locked(&state, &path) {
        return Ok(Vec::new());
    }
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
    Ok(lg.outgoing_for(&path).unwrap_or_default())
}

// ── get_unresolved_links ───────────────────────────────────────────────────────

/// Return all wiki-links across the vault that could not be resolved.
#[tauri::command]
pub async fn get_unresolved_links(
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<UnresolvedLink>, VaultError> {
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
    let raw = lg.get_unresolved();
    drop(lg);
    // #345: unresolved-link rows whose source lives in a locked folder
    // would leak the locked filename through the broken-link UI.
    Ok(raw
        .into_iter()
        .filter(|u| !is_rel_path_locked(&state, &u.source_path))
        .collect())
}

// ── suggest_links ──────────────────────────────────────────────────────────────

/// Fuzzy filename search for `[[` autocomplete — delegates to nucleo matcher.
///
/// Candidate set: filenames AND frontmatter aliases (issue #60). Alias hits
/// carry the matched alias text in `matched_alias` so the popup can render
/// `alias → filename`. When the same file surfaces from both a filename and
/// an alias haystack, the higher-scoring row wins (filename hits take the
/// tiebreak so ranking stays consistent with pure-filename search).
#[tauri::command]
pub async fn suggest_links(
    query: String,
    limit: usize,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<FileMatch>, VaultError> {
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

    // Snapshot paths + per-file aliases under a single lock so the subsequent
    // matcher work runs without holding the FileIndex mutex.
    let (paths, file_aliases): (Vec<String>, Vec<(String, Vec<String>)>) = {
        let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
        let paths = fi.all_relative_paths();
        let aliases: Vec<(String, Vec<String>)> = fi
            .all_entries()
            .map(|(_, m)| (m.relative_path.clone(), m.aliases.clone()))
            .filter(|(_, a)| !a.is_empty())
            .collect();
        (paths, aliases)
    };

    // Empty query: return the first N files sorted alphabetically (Obsidian-style
    // "browse" mode for [[|]]). Skip nucleo ranking — there's no pattern to rank by.
    // Aliases are not surfaced in browse mode; alias surfacing requires a query.
    if query.trim().is_empty() {
        let mut sorted = paths;
        sorted.sort_unstable();
        sorted.truncate(effective_limit);
        return Ok(sorted
            .into_iter()
            .map(|path| FileMatch {
                path,
                score: 0,
                match_indices: Vec::new(),
                matched_alias: None,
            })
            .collect());
    }

    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);

    let mut buf: Vec<char> = Vec::new();
    let mut matches: Vec<FileMatch> = {
        let mut matcher = matcher_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;

        // Filename haystack
        let mut out: Vec<FileMatch> = paths
            .iter()
            .filter_map(|path| {
                buf.clear();
                let haystack = Utf32Str::new(path, &mut buf);
                let mut indices: Vec<u32> = Vec::new();
                let score = pattern.indices(haystack, &mut matcher, &mut indices)?;
                indices.sort_unstable();
                indices.dedup();
                Some(FileMatch {
                    path: path.clone(),
                    score,
                    match_indices: indices,
                    matched_alias: None,
                })
            })
            .collect();

        // Alias haystack — one nucleo pass per (file, alias) pair. Alias
        // matches carry empty `match_indices` because the indices would point
        // into the alias string, not the path shown in the popup.
        for (rel_path, aliases) in &file_aliases {
            for alias in aliases {
                buf.clear();
                let haystack = Utf32Str::new(alias, &mut buf);
                let mut indices: Vec<u32> = Vec::new();
                if let Some(score) = pattern.indices(haystack, &mut matcher, &mut indices) {
                    out.push(FileMatch {
                        path: rel_path.clone(),
                        score,
                        match_indices: Vec::new(),
                        matched_alias: Some(alias.clone()),
                    });
                }
            }
        }

        out
    };

    // Per-path dedupe: keep the best row per file. Tie-break prefers filename
    // hits (matched_alias=None) over alias hits so ranking stays predictable
    // when a note's filename and alias both score equally.
    matches.sort_unstable_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| {
            // alias None sorts before alias Some at equal score
            match (&a.matched_alias, &b.matched_alias) {
                (None, Some(_)) => std::cmp::Ordering::Less,
                (Some(_), None) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            }
        })
    });

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    matches.retain(|m| seen.insert(m.path.clone()));
    matches.truncate(effective_limit);

    Ok(matches)
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
    // #392 PR-B: link cascade is desktop-only (uses walkdir + raw fs
    // reads). On Android the frontend already received link_count=0
    // from rename_file; this no-op makes the follow-up call safe.
    #[cfg(target_os = "android")]
    if matches!(
        *state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?,
        Some(crate::storage::VaultHandle::ContentUri(_))
    ) {
        let _ = (old_path, new_path);
        return Ok(RenameResult {
            updated_files: 0,
            updated_links: 0,
            failed_files: Vec::new(),
            updated_paths: Vec::new(),
        });
    }

    // Get vault root — clone before releasing the lock.
    let vault_root: PathBuf = {
        let vp = state.current_vault.lock().map_err(|_| VaultError::VaultUnavailable {
            path: String::new(),
        })?;
        match vp.as_ref() {
            Some(h) => h.expect_posix().to_path_buf(),
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

    // Regex: [[old_stem]], [[old_stem#H]], [[old_stem^id]], [[old_stem|alias]],
    // [[old_stem#H|alias]], [[old_stem^id|alias]], or any combination thereof.
    // #62: heading and block-id suffixes are captured separately so the
    // rewriter preserves them on the rewritten link instead of collapsing
    // every cascade'd link to a bare stem reference.
    let pattern = format!(
        r"\[\[{}(#[^\]\|\^]+)?(\^[A-Za-z0-9-]+)?(\|[^\]]*)?(\]\])",
        regex::escape(old_stem)
    );
    let re = Regex::new(&pattern).map_err(|e| {
        VaultError::Io(std::io::Error::other(e.to_string()))
    })?;

    // BUG-04.1 FIX: Iterate ALL vault files (parallel with rayon) instead of
    // reading lg.incoming_for(&old_path). The link graph may already be out of
    // sync because the watcher dispatched RemoveLinks(old_path) after the disk
    // rename but before this function runs — incoming_for would return empty.
    //
    // This is also the RESEARCH.md Pattern 6 design (rayon parallel rewrite)
    // which the original implementation silently substituted with a graph lookup.
    let (fi_arc, lg_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.file_index(), c.link_graph()),
            None => return Ok(RenameResult { updated_files: 0, updated_links: 0, failed_files: vec![], updated_paths: vec![] }),
        }
    };

    let all_paths: Vec<String> = {
        let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
        fi.all_relative_paths()
    };

    /// Result of scanning one file: either it matched (carry the rewrite), errored, or was skipped.
    enum ScanOutcome {
        Match { link_count: usize, new_content: String },
        Skip,
        Error,
    }

    // Parallel regex scan + rewrite produced in a single pass.
    // write_ignore requires mutex access, so writes happen sequentially in the second pass.
    let rewrite_results: Vec<(String, ScanOutcome)> = all_paths
        .par_iter()
        .filter(|p| p.ends_with(".md") && p.as_str() != new_path)
        .map(|source_rel| -> (String, ScanOutcome) {
            let abs_path = vault_root.join(source_rel);

            // T-04-01: vault-scope guard
            let canonical = match abs_path.canonicalize() {
                Ok(c) => c,
                Err(_) => return (source_rel.clone(), ScanOutcome::Error),
            };
            if !canonical.starts_with(&vault_root) {
                return (source_rel.clone(), ScanOutcome::Error);
            }

            let content = match std::fs::read_to_string(&abs_path) {
                Ok(c) => c,
                Err(_) => return (source_rel.clone(), ScanOutcome::Error),
            };

            // Fast-path: skip files that don't mention the old stem at all.
            if !content.contains(old_stem) {
                return (source_rel.clone(), ScanOutcome::Skip);
            }

            let (new_content, link_count) =
                rewrite_wiki_links_respecting_templates(&content, &re, new_stem);

            if link_count == 0 {
                return (source_rel.clone(), ScanOutcome::Skip);
            }

            (source_rel.clone(), ScanOutcome::Match { link_count, new_content })
        })
        .collect();

    // Second pass (sequential): record write_ignore then write for each match.
    // Issue #258: keep `new_content` in hand so the downstream link-graph update
    // doesn't re-read the exact same bytes we just wrote. Per source file we
    // avoid one `read_to_string` syscall + allocation + UTF-8 validation.
    let mut updated_files = 0usize;
    let mut updated_links = 0usize;
    let mut failed_files: Vec<String> = Vec::new();
    let mut rewrites: Vec<(String, String)> = Vec::new();

    for (source_rel, outcome) in rewrite_results {
        let (link_count, new_content) = match outcome {
            ScanOutcome::Error => {
                failed_files.push(source_rel);
                continue;
            }
            ScanOutcome::Skip => continue,
            ScanOutcome::Match { link_count, new_content } => (link_count, new_content),
        };

        let abs_path = vault_root.join(&source_rel);

        // T-04-02: record in write_ignore before writing
        {
            let mut ignore = state.write_ignore.lock().map_err(|_| VaultError::IndexCorrupt)?;
            ignore.record(abs_path.clone());
        }

        if std::fs::write(&abs_path, &new_content).is_err() {
            failed_files.push(source_rel);
            continue;
        }

        updated_files += 1;
        updated_links += link_count;
        rewrites.push((source_rel, new_content));
    }

    // Update link graph for each successfully rewritten file + the renamed file.
    // For rewritten sources we use the in-memory `new_content` — it is byte-
    // identical to what we just wrote (the write just completed, nothing else
    // can race since write_ignore already suppresses the watcher loopback).
    //
    // Perf (#250): build the vault-wide StemIndex once so each
    // `update_file_with_index` call avoids the old 2×O(N) scan per link.
    {
        let stem_index = link_graph::StemIndex::build(&all_paths);
        let mut lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        apply_rewrites_to_graph(&mut lg, &rewrites, &stem_index);
        // Also update the renamed file itself in the graph. This read stays:
        // this function never rewrote the renamed file, so we don't have its
        // content in memory. It's also a single read, not N, so outside the
        // N-file perf burst the issue targets.
        lg.remove_file(&old_path);
        let new_abs = vault_root.join(&new_path);
        if let Ok(content) = std::fs::read_to_string(&new_abs) {
            let links = link_graph::extract_links(&content);
            lg.update_file_with_index(&new_path, links, &stem_index);
        }
    }

    // #339: each rewritten source has new body text (`[[old]]` → `[[new]]`),
    // so Tantivy fulltext hits for the old stem in these files are stale
    // until re-indexing. The link graph is already updated inline above
    // (#250 keeps that direct-mutation path for perf — routing through
    // dispatch_self_write would regress the StemIndex optimization). Fire
    // just the Tantivy side here via the shared upsert helper so the
    // document shape stays in sync with dispatch_self_write. Tags aren't
    // affected — the rewrite only touches wiki-link text.
    let tx = {
        let guard = state.index_coordinator.lock().map_err(|_| VaultError::IndexCorrupt)?;
        guard.as_ref().map(|c| c.tx.clone())
    };
    if let Some(tx) = tx {
        for (source_rel, new_content) in &rewrites {
            let abs_path = vault_root.join(source_rel);
            crate::commands::index_dispatch::dispatch_tantivy_upsert(&tx, &abs_path, new_content)
                .await;
        }
        let _ = tx.send(crate::indexer::IndexCmd::Commit).await;
    }

    let updated_paths: Vec<String> = rewrites.into_iter().map(|(rel, _)| rel).collect();

    Ok(RenameResult {
        updated_files,
        updated_links,
        failed_files,
        updated_paths,
    })
}

/// Apply in-memory rewrites to the link graph.
///
/// Issue #258: takes `(rel_path, content)` pairs so the graph update does not
/// re-read files that `update_links_after_rename` just wrote. The content is
/// parsed in-place via `link_graph::extract_links`; the graph itself is updated
/// via `LinkGraph::update_file_with_index`. No filesystem access.
///
/// Issue #250: takes a pre-built `StemIndex` so the rewrites share a single
/// `O(N)` build instead of re-building inside every `update_file` call.
fn apply_rewrites_to_graph(
    lg: &mut LinkGraph,
    rewrites: &[(String, String)],
    stem_index: &link_graph::StemIndex,
) {
    for (source_rel, content) in rewrites {
        let links = link_graph::extract_links(content);
        lg.update_file_with_index(source_rel, links, stem_index);
    }
}

// ── get_resolved_links ─────────────────────────────────────────────────────────

/// Return a (stem OR alias) → vault-relative-path map for all files in the vault.
///
/// Keys are lowercased — stems come from filenames, aliases come from YAML
/// frontmatter (issue #60). Values are vault-relative paths. The frontend
/// converts this to `Map<string, string>` for zero-IPC click handling.
///
/// Collision priority (also documented at the call site in `link_graph::
/// resolved_map_with_aliases`):
///   1. Filename-stem match wins over alias match.
///   2. Between two aliases on different notes, first-indexed wins; the loser
///      is logged.
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

    let (mut paths, file_aliases) = {
        let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
        let paths = fi.all_relative_paths();
        let file_aliases: Vec<(String, Vec<String>)> = fi
            .all_entries()
            .map(|(_, m)| (m.relative_path.clone(), m.aliases.clone()))
            .collect();
        (paths, file_aliases)
    };

    // #147 — wiki-links like `[[mycanvas]]` should resolve to `.canvas` files
    // the same way they resolve to notes. Canvases are not indexed by Tantivy
    // or the FileIndex, so walk the filesystem once here and union the results
    // into the path list fed to `resolved_map_with_aliases`. The cost is the
    // same O(N) directory walk the attachment command already performs.
    let vault_path = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        guard.as_ref().map(|h| h.expect_posix().to_path_buf())
    };
    if let Some(vp) = vault_path {
        paths.extend(crate::indexer::collect_canvas_rel_paths(&vp));
    }

    // #345: strip locked-folder paths + their aliases before building
    // the resolver map. Without this, a wiki-link `[[Secret]]` would
    // resolve to a path inside a locked root and the frontend would
    // route-click the user straight into a locked file open attempt.
    // Use LockedRelChecker so the common "no encrypted folders" case
    // short-circuits cheaply at 100k-note scale.
    let checker = LockedRelChecker::new(&state);
    paths.retain(|p| !checker.is_locked(p));
    let filtered_aliases: Vec<(String, Vec<String>)> = file_aliases
        .into_iter()
        .filter(|(p, _)| !checker.is_locked(p))
        .collect();
    Ok(link_graph::resolved_map_with_aliases(&paths, &filtered_aliases))
}

// ── get_resolved_anchors ───────────────────────────────────────────────────────

/// Return a `rel_path -> AnchorKeySet` map covering every indexed file that
/// owns at least one block-id or heading anchor (#62).
///
/// Two design decisions baked in:
///   1. **Keyed by rel_path**, not stem. Anchor data is unambiguous given the
///      file's relative path; stems can collide across folders.
///   2. **UTF-16 offsets are precomputed in Rust.** The frontend slices
///      `noteContentCache` content (a JS string) directly with `js_start /
///      js_end`, which avoids byte-vs-code-unit drift on multi-byte content
///      (CJK, emoji). Byte offsets are still surfaced for tools and tests.
///
/// Empty entries are skipped so the wire payload stays bounded — most notes
/// in a typical vault carry zero anchors.
#[tauri::command]
pub async fn get_resolved_anchors(
    state: tauri::State<'_, VaultState>,
) -> Result<HashMap<String, AnchorKeySet>, VaultError> {
    let ai_arc = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => c.anchor_index(),
            None => return Ok(HashMap::new()),
        }
    };

    let snapshot = {
        let ai = ai_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        ai.snapshot_payload()
    };

    // #345 parity with `get_resolved_links`: drop entries whose path lives
    // inside a locked encrypted root so anchor data doesn't leak.
    let checker = LockedRelChecker::new(&state);
    Ok(snapshot
        .into_iter()
        .filter(|(rel, ks)| {
            !checker.is_locked(rel) && (!ks.blocks.is_empty() || !ks.headings.is_empty())
        })
        .collect())
}

// ── get_resolved_attachments ───────────────────────────────────────────────────

/// Return a `filename (lowercased, with extension) → vault-relative path` map
/// for every image attachment reachable from the vault root.
///
/// Images are not indexed by the main FileIndex (which only tracks `.md`
/// files), so this command walks the filesystem directly with `walkdir`.
/// Skips dotfiles, `.git`, `.obsidian`, `.vaultcore`, `.trash`, and `templates`
/// (if present). `.md` files are excluded — those are covered by
/// `get_resolved_links`.
///
/// The frontend uses this map for the wiki-embed plugin: `![[foo.png]]` looks
/// up the lowercased filename to resolve to a vault-relative path, which is
/// then passed through `convertFileSrc` to get an asset-protocol URL.
///
/// On a missing or unopened vault the command returns an empty map so the
/// frontend can still render without surfacing an error to the user.
#[tauri::command]
pub async fn get_resolved_attachments(
    state: tauri::State<'_, VaultState>,
) -> Result<HashMap<String, String>, VaultError> {
    let vault_root: PathBuf = {
        let guard = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(crate::storage::VaultHandle::Posix(p)) => p.clone(),
            // #392 PR-B: attachment resolution walks the vault tree
            // with WalkDir — desktop-only. Returns empty so the
            // frontend's image-render fallback kicks in.
            #[cfg(target_os = "android")]
            Some(crate::storage::VaultHandle::ContentUri(_)) => return Ok(HashMap::new()),
            None => return Ok(HashMap::new()),
        }
    };

    let mut map: HashMap<String, String> = HashMap::new();

    for entry in WalkDir::new(&vault_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Keep the root, skip dotfiles and known junk directories.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_str().unwrap_or("");
            if name.starts_with('.') {
                return false;
            }
            if e.file_type().is_dir() && SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d)) {
                return false;
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext_lower = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_ascii_lowercase(),
            None => continue,
        };
        if ext_lower == "md" {
            continue;
        }
        if !IMAGE_EXTENSIONS.iter().any(|e| *e == ext_lower) {
            continue;
        }
        // #345: skip attachments inside locked roots so wiki-embed
        // asset URLs don't leak filenames.
        let canon = CanonicalPath::assume_canonical(path.to_path_buf());
        if state.locked_paths.is_locked(&canon) {
            continue;
        }

        let Ok(rel) = path.strip_prefix(&vault_root) else { continue };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let key = filename.to_ascii_lowercase();

        // First-hit wins; ambiguous duplicates (same filename in different
        // folders) are rare in practice for image assets and a follow-up can
        // add shortest-path disambiguation if needed.
        map.entry(key).or_insert(rel_str);
    }

    Ok(map)
}

// ── get_local_graph ────────────────────────────────────────────────────────────

/// Hard cap on the total number of nodes returned by a single local-graph
/// query. Pathologically-linked hubs would otherwise produce thousands of
/// nodes for a 2-hop neighborhood and stall the sigma renderer on mount.
const LOCAL_GRAPH_NODE_CAP: usize = 500;

/// A single node in the local graph view. Serialized to the frontend with
/// camelCase field names to match the wrapping TS interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// Node id — the vault-relative path for resolved files, or the raw
    /// wiki-link target (prefixed `unresolved:`) for dangling links.
    pub id: String,
    /// Display label — filename stem for resolved files, link text as-written
    /// for unresolved targets.
    pub label: String,
    /// Vault-relative path (equal to `id` for resolved, empty string for
    /// unresolved synthetic nodes).
    pub path: String,
    /// Resolved-incoming-link count for node sizing. Zero for unresolved.
    pub backlink_count: usize,
    /// `true` when the node corresponds to an actual file in the vault.
    pub resolved: bool,
    /// Lowercased tags present in the file (deduplicated, sorted).
    /// Empty for unresolved pseudo-nodes and for callers that don't populate
    /// tag information (e.g. the local-graph command).
    #[serde(default)]
    pub tags: Vec<String>,
}

/// An undirected edge between two graph nodes. Dedupe is performed at build
/// time via a sorted-pair `HashSet`, so no `(a, b)` / `(b, a)` duplicates
/// reach the renderer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

/// Result payload returned by `get_local_graph`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Derive a filename stem from a vault-relative path (strip folder + `.md`).
pub(crate) fn file_stem_label(rel_path: &str) -> String {
    let base = rel_path.rsplit('/').next().unwrap_or(rel_path);
    base.strip_suffix(".md").unwrap_or(base).to_string()
}

/// Pure helper that computes the 2-hop (or arbitrary-depth) local graph for
/// a center note. Split out from the Tauri command so it can be exercised by
/// `cargo test local_graph` without standing up a full `VaultState`.
///
/// BFS in both directions (outgoing links + backlinks). Every node visited
/// within `depth` hops is emitted; every edge discovered while expanding is
/// emitted as an undirected pair (smaller id first). Unresolved link targets
/// are synthesized as pseudo-nodes with `resolved: false` and an
/// `unresolved:<raw>` id so they never collide with real paths.
pub fn compute_local_graph(
    center: &str,
    depth: u32,
    lg: &LinkGraph,
    fi: &FileIndex,
) -> LocalGraph {
    let mut nodes: HashMap<String, GraphNode> = HashMap::new();
    let mut edges: HashSet<(String, String)> = HashSet::new();
    let mut visited: HashSet<String> = HashSet::new();

    // Build a rel_path → title map once so label lookups are O(1).
    let mut titles: HashMap<String, String> = HashMap::new();
    for (_, meta) in fi.all_entries() {
        titles.insert(meta.relative_path.clone(), meta.title.clone());
    }

    let is_resolved = |id: &str| titles.contains_key(id);

    // Node factory — resolved vs unresolved handled uniformly.
    let make_node = |id: &str, lg: &LinkGraph, raw_fallback: Option<&str>| -> GraphNode {
        if let Some(_title) = titles.get(id) {
            GraphNode {
                id: id.to_string(),
                label: file_stem_label(id),
                path: id.to_string(),
                backlink_count: lg.backlink_count(id),
                resolved: true,
                tags: Vec::new(),
            }
        } else {
            // Unresolved pseudo-node. `label` is the raw link text if supplied,
            // otherwise the (already prefix-stripped) id itself.
            let label = raw_fallback
                .map(|s| s.to_string())
                .unwrap_or_else(|| id.trim_start_matches("unresolved:").to_string());
            GraphNode {
                id: id.to_string(),
                label,
                path: String::new(),
                backlink_count: 0,
                resolved: false,
                tags: Vec::new(),
            }
        }
    };

    // Seed the frontier with the center node. Even if the center doesn't
    // exist in the FileIndex (e.g. a just-created file whose indexing is
    // lagging), we still emit it as a lone, resolved-looking node so the
    // panel has something to render.
    let center_node = if is_resolved(center) {
        make_node(center, lg, None)
    } else {
        GraphNode {
            id: center.to_string(),
            label: file_stem_label(center),
            path: center.to_string(),
            backlink_count: lg.backlink_count(center),
            resolved: true,
            tags: Vec::new(),
        }
    };
    nodes.insert(center.to_string(), center_node);
    visited.insert(center.to_string());

    // Insert an edge keyed by a canonical ordering so (a, b) == (b, a).
    let insert_edge = |edges: &mut HashSet<(String, String)>, a: &str, b: &str| {
        if a == b {
            return;
        }
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        edges.insert((lo.to_string(), hi.to_string()));
    };

    let mut frontier: VecDeque<(String, u32)> = VecDeque::new();
    frontier.push_back((center.to_string(), 0));

    while let Some((current, hop)) = frontier.pop_front() {
        if hop >= depth {
            continue;
        }
        if nodes.len() >= LOCAL_GRAPH_NODE_CAP {
            break;
        }

        // Outgoing links (resolved + unresolved).
        if let Some(targets) = lg.outgoing_targets_for(&current) {
            for (resolved, raw) in targets {
                let (neighbor_id, raw_for_label): (String, Option<&str>) = match resolved {
                    Some(path) => (path, None),
                    None => (format!("unresolved:{}", raw), Some(raw.as_str())),
                };

                if nodes.len() >= LOCAL_GRAPH_NODE_CAP && !nodes.contains_key(&neighbor_id) {
                    continue;
                }

                insert_edge(&mut edges, &current, &neighbor_id);
                nodes
                    .entry(neighbor_id.clone())
                    .or_insert_with(|| make_node(&neighbor_id, lg, raw_for_label));

                if visited.insert(neighbor_id.clone()) {
                    frontier.push_back((neighbor_id, hop + 1));
                }
            }
        }

        // Incoming links (backlinks). Always resolved — incoming only records
        // the source rel_path of files that themselves exist in the graph.
        if let Some(sources) = lg.incoming_for(&current) {
            for source in sources.clone() {
                if nodes.len() >= LOCAL_GRAPH_NODE_CAP && !nodes.contains_key(&source) {
                    continue;
                }
                insert_edge(&mut edges, &current, &source);
                nodes
                    .entry(source.clone())
                    .or_insert_with(|| make_node(&source, lg, None));

                if visited.insert(source.clone()) {
                    frontier.push_back((source, hop + 1));
                }
            }
        }
    }

    // Stable output order — alphabetical ids. Helps snapshot tests and keeps
    // the force layout's initial random placement reproducible run-to-run.
    let mut node_list: Vec<GraphNode> = nodes.into_values().collect();
    node_list.sort_by(|a, b| a.id.cmp(&b.id));

    let mut edge_list: Vec<GraphEdge> = edges
        .into_iter()
        .map(|(from, to)| GraphEdge { from, to })
        .collect();
    edge_list.sort_by(|a, b| a.from.cmp(&b.from).then_with(|| a.to.cmp(&b.to)));

    LocalGraph {
        nodes: node_list,
        edges: edge_list,
    }
}

/// Tauri command — return the 2-hop (or `depth`-hop) local link graph around
/// a center note. Both outgoing links and backlinks are traversed. Unresolved
/// wiki-link targets surface as synthetic nodes with `resolved: false`.
#[tauri::command]
pub async fn get_local_graph(
    path: String,
    depth: u32,
    state: tauri::State<'_, VaultState>,
) -> Result<LocalGraph, VaultError> {
    // #345: center on a locked path → empty graph. The graph around a
    // locked file is itself locked state.
    if is_rel_path_locked(&state, &path) {
        return Ok(LocalGraph {
            nodes: Vec::new(),
            edges: Vec::new(),
        });
    }
    let (lg_arc, fi_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.link_graph(), c.file_index()),
            None => {
                return Ok(LocalGraph {
                    nodes: Vec::new(),
                    edges: Vec::new(),
                })
            }
        }
    };

    let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
    let lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;

    let raw = compute_local_graph(&path, depth, &lg, &fi);
    drop(lg);
    drop(fi);
    // #345: drop any node/edge whose endpoints live inside a locked
    // root. Leaking filenames through the graph view is explicitly out
    // of the acceptance criteria ("locked folder is fully invisible to
    // … graph").
    Ok(filter_graph_for_locked(&state, raw))
}

fn filter_graph_for_locked(state: &VaultState, mut g: LocalGraph) -> LocalGraph {
    let checker = LockedRelChecker::new(state);
    if checker.prefixes.is_empty() {
        return g;
    }
    let locked_ids: HashSet<String> = g
        .nodes
        .iter()
        .filter(|n| checker.is_locked(&n.path))
        .map(|n| n.id.clone())
        .collect();
    if locked_ids.is_empty() {
        return g;
    }
    g.nodes.retain(|n| !locked_ids.contains(&n.id));
    g.edges
        .retain(|e| !locked_ids.contains(&e.from) && !locked_ids.contains(&e.to));
    g
}

// ── get_link_graph ─────────────────────────────────────────────────────────────

/// Pure helper that builds the whole-vault link graph. Split out from the
/// Tauri command so unit tests can exercise it without standing up a
/// VaultState.
///
/// Every indexed `.md` file becomes a resolved node. Every resolved outgoing
/// link becomes an undirected edge (deduped via a sorted-pair set). Every
/// unresolved link target becomes a pseudo-node with `resolved: false`,
/// mirroring the local-graph convention so the frontend reducers can share
/// code.
pub fn compute_link_graph(
    lg: &LinkGraph,
    fi: &FileIndex,
    ti: &TagIndex,
) -> LocalGraph {
    let all_paths: Vec<String> = fi.all_relative_paths();

    let mut nodes: HashMap<String, GraphNode> = HashMap::with_capacity(all_paths.len());
    let mut edges: HashSet<(String, String)> = HashSet::new();

    // Resolved nodes — every indexed file.
    for rel in &all_paths {
        nodes.insert(
            rel.clone(),
            GraphNode {
                id: rel.clone(),
                label: file_stem_label(rel),
                path: rel.clone(),
                backlink_count: lg.backlink_count(rel),
                resolved: true,
                tags: ti.tags_for_file(rel),
            },
        );
    }

    let insert_edge = |edges: &mut HashSet<(String, String)>, a: &str, b: &str| {
        if a == b {
            return;
        }
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        edges.insert((lo.to_string(), hi.to_string()));
    };

    // Walk every file's outgoing targets. Resolved targets → direct edge;
    // unresolved targets → synthesize a pseudo-node + edge.
    for rel in &all_paths {
        let Some(targets) = lg.outgoing_targets_for(rel) else {
            continue;
        };
        for (resolved_target, raw) in targets {
            match resolved_target {
                Some(target) => {
                    insert_edge(&mut edges, rel, &target);
                }
                None => {
                    let id = format!("unresolved:{}", raw);
                    nodes.entry(id.clone()).or_insert_with(|| GraphNode {
                        id: id.clone(),
                        label: raw.clone(),
                        path: String::new(),
                        backlink_count: 0,
                        resolved: false,
                        tags: Vec::new(),
                    });
                    insert_edge(&mut edges, rel, &id);
                }
            }
        }
    }

    // Stable output order — alphabetical ids. Keeps force layout seed
    // reproducible and snapshot tests tidy.
    let mut node_list: Vec<GraphNode> = nodes.into_values().collect();
    node_list.sort_by(|a, b| a.id.cmp(&b.id));

    let mut edge_list: Vec<GraphEdge> = edges
        .into_iter()
        .map(|(from, to)| GraphEdge { from, to })
        .collect();
    edge_list.sort_by(|a, b| a.from.cmp(&b.from).then_with(|| a.to.cmp(&b.to)));

    LocalGraph {
        nodes: node_list,
        edges: edge_list,
    }
}

/// Tauri command — return the full vault link graph. One resolved node per
/// indexed `.md` file, one pseudo-node per unique unresolved target, one
/// undirected edge per resolved wiki-link (deduped).
#[tauri::command]
pub async fn get_link_graph(
    state: tauri::State<'_, VaultState>,
) -> Result<LocalGraph, VaultError> {
    let (lg_arc, fi_arc, ti_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(c) => (c.link_graph(), c.file_index(), c.tag_index()),
            None => {
                return Ok(LocalGraph {
                    nodes: Vec::new(),
                    edges: Vec::new(),
                })
            }
        }
    };

    let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
    let lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
    let ti = ti_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;

    let raw = compute_link_graph(&lg, &fi, &ti);
    drop(ti);
    drop(lg);
    drop(fi);
    // #345: strip locked endpoints + any edge that touches them.
    Ok(filter_graph_for_locked(&state, raw))
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Issue #258: rewrite burst must update the graph from the in-memory
    // content that was just written, not by re-reading each file from disk.
    //
    // This test proves it by passing paths that do NOT exist on disk: if the
    // helper re-read from disk the graph would stay empty for those sources.
    // Since `update_file` uses the in-memory content we pass in, the graph
    // picks up the expected outgoing links.
    #[test]
    fn apply_rewrites_to_graph_uses_in_memory_content_not_disk() {
        let all_paths = vec![
            "Target.md".to_string(),
            "Other.md".to_string(),
            "src_a.md".to_string(),
            "src_b.md".to_string(),
        ];

        // Paths that are guaranteed absent from any filesystem — a disk read
        // here would fail, so if the graph ends up populated correctly it
        // proves the helper consumed the in-memory strings.
        let rewrites = vec![
            ("src_a.md".to_string(), "before [[Target]] after".to_string()),
            ("src_b.md".to_string(), "link [[Target]] and [[Other]]".to_string()),
        ];

        let mut lg = LinkGraph::new();
        let stem_index = link_graph::StemIndex::build(&all_paths);
        apply_rewrites_to_graph(&mut lg, &rewrites, &stem_index);

        let out_a = lg.outgoing_for("src_a.md").expect("src_a must have outgoing");
        assert_eq!(out_a.len(), 1);
        assert_eq!(out_a[0].target_raw, "Target");

        let out_b = lg.outgoing_for("src_b.md").expect("src_b must have outgoing");
        assert_eq!(out_b.len(), 2);
        assert_eq!(out_b[0].target_raw, "Target");
        assert_eq!(out_b[1].target_raw, "Other");

        // Incoming side also populated from the in-memory content.
        let in_target = lg
            .incoming_for("Target.md")
            .expect("Target must have incoming");
        assert!(in_target.contains(&"src_a.md".to_string()));
        assert!(in_target.contains(&"src_b.md".to_string()));
    }

    // A sibling guard: rewrites are idempotent — re-applying the same set
    // must not duplicate outgoing entries. `update_file` already clears the
    // previous state per source, so this locks the helper in on that
    // contract in case someone replaces the body later.
    #[test]
    fn apply_rewrites_to_graph_is_idempotent() {
        let all_paths = vec!["Target.md".to_string(), "src.md".to_string()];
        let rewrites = vec![("src.md".to_string(), "[[Target]]".to_string())];

        let mut lg = LinkGraph::new();
        let stem_index = link_graph::StemIndex::build(&all_paths);
        apply_rewrites_to_graph(&mut lg, &rewrites, &stem_index);
        apply_rewrites_to_graph(&mut lg, &rewrites, &stem_index);

        let out = lg.outgoing_for("src.md").unwrap();
        assert_eq!(out.len(), 1);
        let incoming = lg.incoming_for("Target.md").unwrap();
        assert_eq!(incoming.len(), 1);
    }

    // ── rewrite_wiki_links_respecting_templates ────────────────────────────
    //
    // #330 follow-up (#331 review): the disk-writing half of the rename flow
    // must refuse to rewrite `[[old_stem]]` occurrences that live inside a
    // `{{ ... }}` template body, because those are source code, not real
    // wiki-links. Without this guard, renaming `foo` → `bar` would silently
    // mutate every template that reads `n.name == "foo"` into `n.name == "bar"`,
    // which is data corruption — the template output changes on the next
    // render and the user may not notice until much later.

    fn build_rename_regex(old_stem: &str) -> regex::Regex {
        let pattern = format!(
            r"\[\[{}(#[^\]\|\^]+)?(\^[A-Za-z0-9-]+)?(\|[^\]]*)?(\]\])",
            regex::escape(old_stem)
        );
        regex::Regex::new(&pattern).expect("test regex must compile")
    }

    #[test]
    fn rewrite_leaves_wiki_links_inside_template_bodies_untouched() {
        let re = build_rename_regex("foo");
        // `[[foo]]` appears only inside a template body — rename must be a no-op.
        let content = r#"see {{ vault.notes.where(n => n.name == "[[foo]]") }} end"#;
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 0);
        assert_eq!(out, content, "template body must not be modified");
    }

    #[test]
    fn rewrite_updates_real_links_and_preserves_template_links() {
        let re = build_rename_regex("foo");
        // Real `[[foo]]` on one line, fake one inside a template on the next.
        // Only the real one must be rewritten; the template stays byte-identical.
        let content = "real [[foo]]\nfake {{ \"[[foo]]\" }}";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 1);
        assert_eq!(out, "real [[bar]]\nfake {{ \"[[foo]]\" }}");
    }

    #[test]
    fn rewrite_preserves_alias_on_real_link() {
        let re = build_rename_regex("foo");
        let content = "[[foo|display text]]";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 1);
        assert_eq!(out, "[[bar|display text]]");
    }

    #[test]
    fn rewrite_noop_when_stem_not_present() {
        let re = build_rename_regex("foo");
        let content = "nothing to see here [[other]]";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 0);
        assert_eq!(out, content);
    }

    // ── #62: rename cascade preserves block-id and heading suffixes ────────

    #[test]
    fn rewrite_preserves_heading_anchor_on_rename() {
        let re = build_rename_regex("foo");
        let content = "see [[foo#Section Title]] for more";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 1);
        assert_eq!(out, "see [[bar#Section Title]] for more");
    }

    #[test]
    fn rewrite_preserves_block_anchor_on_rename() {
        let re = build_rename_regex("foo");
        let content = "see [[foo^para1]] then [[foo^para2]]";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 2);
        assert_eq!(out, "see [[bar^para1]] then [[bar^para2]]");
    }

    #[test]
    fn rewrite_preserves_heading_plus_alias() {
        let re = build_rename_regex("foo");
        let content = "[[foo#Heading|Display]]";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 1);
        assert_eq!(out, "[[bar#Heading|Display]]");
    }

    #[test]
    fn rewrite_preserves_block_plus_alias() {
        let re = build_rename_regex("foo");
        let content = "[[foo^id|caption]]";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 1);
        assert_eq!(out, "[[bar^id|caption]]");
    }

    #[test]
    fn rewrite_handles_multiline_template_containing_old_stem() {
        let re = build_rename_regex("foo");
        // Multi-line template body containing `[[foo]]`; real `[[foo]]`
        // afterwards must still be rewritten.
        let content = "{{\nvault.notes.where(n =>\n  n.name == \"[[foo]]\")\n}}\nreal: [[foo]]";
        let (out, count) = rewrite_wiki_links_respecting_templates(content, &re, "bar");
        assert_eq!(count, 1);
        assert_eq!(
            out,
            "{{\nvault.notes.where(n =>\n  n.name == \"[[foo]]\")\n}}\nreal: [[bar]]"
        );
    }
}
