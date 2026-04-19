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

use crate::error::VaultError;
use crate::indexer::link_graph::{self, BacklinkEntry, LinkGraph, ParsedLink, UnresolvedLink};
use crate::indexer::memory::FileIndex;
use crate::indexer::tag_index::TagIndex;
use crate::commands::search::FileMatch;
use crate::VaultState;

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

    let fi = fi_arc.read().map_err(|_| VaultError::IndexCorrupt)?;
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
    Ok(lg.get_unresolved())
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

            let mut link_count = 0usize;
            let new_content = re.replace_all(&content, |caps: &regex::Captures| {
                link_count += 1;
                let alias_part = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                format!("[[{}{}]]", new_stem, alias_part)
            }).into_owned();

            if link_count == 0 {
                return (source_rel.clone(), ScanOutcome::Skip);
            }

            (source_rel.clone(), ScanOutcome::Match { link_count, new_content })
        })
        .collect();

    // Second pass (sequential): record write_ignore then write for each match.
    let mut updated_files = 0usize;
    let mut updated_links = 0usize;
    let mut failed_files: Vec<String> = Vec::new();
    let mut rewritten_sources: Vec<String> = Vec::new();

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
        rewritten_sources.push(source_rel);
    }

    // Update link graph for each successfully rewritten file + the renamed file.
    {
        let mut lg = lg_arc.lock().map_err(|_| VaultError::IndexCorrupt)?;
        for source_rel in &rewritten_sources {
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

    Ok(RenameResult {
        updated_files,
        updated_links,
        failed_files,
        updated_paths: rewritten_sources,
    })
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
        guard.clone()
    };
    if let Some(vp) = vault_path {
        paths.extend(crate::indexer::collect_canvas_rel_paths(&vp));
    }

    Ok(link_graph::resolved_map_with_aliases(&paths, &file_aliases))
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
            Some(p) => p.clone(),
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
    /// Optional similarity weight in `[0, 1]`. Link-graph edges leave
    /// this `None`; embedding-graph edges (#235) set it to the max
    /// chunk-pair cosine similarity between the two notes. Skipped in
    /// the serialized payload when absent so the link-graph JSON shape
    /// is unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
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
        .map(|(from, to)| GraphEdge { from, to, weight: None })
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

    Ok(compute_local_graph(&path, depth, &lg, &fi))
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
        .map(|(from, to)| GraphEdge { from, to, weight: None })
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

    Ok(compute_link_graph(&lg, &fi, &ti))
}
