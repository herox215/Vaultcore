// Link graph module — wiki-link parsing, 3-stage resolution, and adjacency list.
//
// Architecture:
// - `extract_links`  — parse `[[target]]` and `[[target|alias]]` from raw Markdown
// - `resolve_link`   — 3-stage Obsidian-compatible resolution (same folder →
//                      shortest path → alphabetical tiebreak)
// - `LinkGraph`      — adjacency list with incremental update/remove
// - `resolved_map`   — free function: stem → rel_path map for frontend click handler
//
// Security (T-04-01): resolve_link returns only vault-relative paths; no absolute
// paths are ever produced here.
// Security (T-04-03): regex `[^\]|]+?` is linear with no backtracking.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use super::memory::FileIndex;

// ── Compiled regex ─────────────────────────────────────────────────────────────

fn wiki_link_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Matches [[target]] and [[target|alias]]
        // [^\]|]+? — lazy match, no ] or | in target; no backtracking risk
        Regex::new(r"\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]").expect("invalid wiki-link regex")
    })
}

// ── Public structs ─────────────────────────────────────────────────────────────

/// A single wiki-link found in a Markdown document.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedLink {
    /// Raw link target as written (e.g. "Note", "Folder/Note", "Note.md").
    pub target_raw: String,
    /// Optional alias text after `|` (e.g. `[[Note|alias]]` → `Some("alias")`).
    pub alias: Option<String>,
    /// 0-based line number where the link appears.
    pub line_number: u32,
    /// The full line text (used as context in backlink entries).
    pub context: String,
}

/// An entry in the backlinks panel for a given target note.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkEntry {
    /// Vault-relative path of the file that contains the link.
    pub source_path: String,
    /// Display title of the source file (from FileIndex).
    pub source_title: String,
    /// Surrounding line text for context display.
    pub context: String,
    /// 0-based line number of the link in the source file.
    pub line_number: u32,
}

/// A wiki-link that could not be resolved to any file in the vault.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedLink {
    /// Vault-relative path of the file that contains the dangling link.
    pub source_path: String,
    /// The raw target string as written in the link.
    pub target_raw: String,
    /// 0-based line number.
    pub line_number: u32,
}

// ── extract_links ──────────────────────────────────────────────────────────────

/// Parse all wiki-links from `content` and return them as `ParsedLink` values.
///
/// Code-block exclusion is intentionally NOT done here — Rust indexes ALL links
/// for graph completeness.  The CM6 layer handles visual suppression in code
/// fences.
pub fn extract_links(content: &str) -> Vec<ParsedLink> {
    let re = wiki_link_regex();
    let mut result = Vec::new();

    for (line_number, line) in content.lines().enumerate() {
        for cap in re.captures_iter(line) {
            let target_raw = cap[1].to_string();
            let alias = cap.get(2).map(|m| m.as_str().to_string());
            result.push(ParsedLink {
                target_raw,
                alias,
                line_number: line_number as u32,
                context: line.to_string(),
            });
        }
    }

    result
}

// ── resolve_link ───────────────────────────────────────────────────────────────

/// Extract the filename stem (basename without `.md` extension) from a path.
fn path_stem(p: &str) -> &str {
    let base = p.rsplit('/').next().unwrap_or(p);
    base.strip_suffix(".md").unwrap_or(base)
}

/// Extract the parent folder portion of a vault-relative path.
/// E.g. "folder/sub/Note.md" → "folder/sub/", "Note.md" → "".
fn path_folder(p: &str) -> &str {
    match p.rfind('/') {
        Some(idx) => &p[..=idx],
        None => "",
    }
}

/// Count the number of path segments (directory depth) in a relative path.
/// "a/b/c.md" → 2 (two slashes = two parent segments).
fn path_depth(p: &str) -> usize {
    p.chars().filter(|&c| c == '/').count()
}

/// Resolve a wiki-link target using Obsidian's 3-stage algorithm:
///
/// 1. Exact stem match in the same folder as the source file.
/// 2. Shortest relative path among all vault files with matching stem.
/// 3. Alphabetical tiebreak.
///
/// Returns the vault-relative path of the resolved file, or `None` if no match.
///
/// Security (T-04-01): returns a vault-relative path, never an absolute path.
pub fn resolve_link(target_raw: &str, source_folder: &str, all_rel_paths: &[String]) -> Option<String> {
    // Strip .md suffix from the target if the user included it
    let stem = target_raw.strip_suffix(".md").unwrap_or(target_raw);
    let stem_lower = stem.to_lowercase();

    // Stage 1: exact stem match in the same folder as the source
    for p in all_rel_paths {
        if path_folder(p) == source_folder && path_stem(p).to_lowercase() == stem_lower {
            return Some(p.clone());
        }
    }

    // Stage 2 + 3: collect all stem matches, sort by (depth, path), return first
    let mut candidates: Vec<&String> = all_rel_paths
        .iter()
        .filter(|p| path_stem(p).to_lowercase() == stem_lower)
        .collect();

    if candidates.is_empty() {
        return None;
    }

    // Sort ascending by depth first, then alphabetically
    candidates.sort_by(|a, b| {
        let da = path_depth(a);
        let db = path_depth(b);
        da.cmp(&db).then_with(|| a.cmp(b))
    });

    candidates.first().map(|p| (*p).clone())
}

// ── StoredLink (internal) ──────────────────────────────────────────────────────

/// Internal representation of a parsed link with its pre-resolved target.
///
/// Resolving is done once at `update_file` time and cached here so that
/// `get_backlinks` and `get_unresolved` can answer queries in O(1) per link
/// instead of re-running the 3-stage resolution algorithm (which was O(n)
/// per link over all vault paths, making `get_backlinks` effectively O(n²)
/// at 100k notes).
#[derive(Debug)]
struct StoredLink {
    parsed: ParsedLink,
    /// Pre-resolved vault-relative target path. `None` means the link is
    /// unresolved (no file in the vault matches the target stem).
    resolved_target: Option<String>,
}

// ── LinkGraph ──────────────────────────────────────────────────────────────────

/// In-memory wiki-link adjacency list.
///
/// `outgoing`: source rel_path → Vec of StoredLinks found in that file.
/// `incoming`: target rel_path → Vec of source rel_paths that resolve to it.
///
/// Both maps are keyed by vault-relative paths with forward-slash separators.
///
/// Resolution is performed once when `update_file` is called and the result
/// is cached in `StoredLink::resolved_target`. This makes `get_backlinks`
/// and `get_unresolved` O(k) where k = number of backlinks, instead of
/// O(n·k) where n = total vault files (the previous implementation called
/// `resolve_link` for every link on every query).
#[derive(Debug, Default)]
pub struct LinkGraph {
    /// Outgoing links per source file (source → stored links with resolved targets).
    outgoing: HashMap<String, Vec<StoredLink>>,
    /// Incoming resolved links per target file (target → sources).
    incoming: HashMap<String, Vec<String>>,
}

impl LinkGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Update (or insert) all links for `source_rel`.
    ///
    /// Idempotent: calling twice for the same source replaces the previous
    /// entries without creating duplicates.
    ///
    /// Resolves each link's target once and caches the result in
    /// `StoredLink::resolved_target` so subsequent queries don't need to
    /// re-run `resolve_link`.
    pub fn update_file(
        &mut self,
        source_rel: &str,
        links: Vec<ParsedLink>,
        all_rel_paths: &[String],
    ) {
        // Clear previous state for this source so updates are idempotent.
        self.remove_file(source_rel);

        let source_folder = path_folder(source_rel).to_string();
        let stored: Vec<StoredLink> = links
            .into_iter()
            .map(|link| {
                let resolved = resolve_link(&link.target_raw, &source_folder, all_rel_paths);
                if let Some(target) = &resolved {
                    self.incoming
                        .entry(target.clone())
                        .or_default()
                        .push(source_rel.to_string());
                }
                StoredLink {
                    parsed: link,
                    resolved_target: resolved,
                }
            })
            .collect();

        self.outgoing.insert(source_rel.to_string(), stored);
    }

    /// Remove all link information for `source_rel`.
    ///
    /// Clears its outgoing entries AND removes it from all incoming lists.
    pub fn remove_file(&mut self, source_rel: &str) {
        self.outgoing.remove(source_rel);

        // Remove source_rel from every incoming entry
        for sources in self.incoming.values_mut() {
            sources.retain(|s| s != source_rel);
        }
        // Clean up empty incoming entries to avoid memory bloat
        self.incoming.retain(|_, v| !v.is_empty());
    }

    /// Return the outgoing parsed links for `source_rel`.
    pub fn outgoing_for(&self, source_rel: &str) -> Option<Vec<ParsedLink>> {
        self.outgoing
            .get(source_rel)
            .map(|v| v.iter().map(|s| s.parsed.clone()).collect())
    }

    /// Return the incoming sources for `target_rel` (immutable borrow).
    pub fn incoming_for(&self, target_rel: &str) -> Option<&Vec<String>> {
        self.incoming.get(target_rel)
    }

    /// Return the outgoing link targets for `source_rel` as `(resolved_target,
    /// target_raw)` pairs. If a link resolved successfully, `resolved_target`
    /// is `Some(path)` and should be used as the neighbor id. If it did not
    /// resolve, `resolved_target` is `None` and the caller may synthesize a
    /// pseudo-node keyed by `target_raw`.
    ///
    /// Duplicates are preserved in source order — the caller is responsible
    /// for deduplication if needed (the local-graph BFS dedupes via a visited
    /// set).
    pub fn outgoing_targets_for(
        &self,
        source_rel: &str,
    ) -> Option<Vec<(Option<String>, String)>> {
        self.outgoing.get(source_rel).map(|stored| {
            stored
                .iter()
                .map(|s| (s.resolved_target.clone(), s.parsed.target_raw.clone()))
                .collect()
        })
    }

    /// Return the number of resolved incoming links for `target_rel`.
    /// Used by the local graph to size nodes proportionally to popularity.
    pub fn backlink_count(&self, target_rel: &str) -> usize {
        self.incoming.get(target_rel).map(|v| v.len()).unwrap_or(0)
    }

    /// Return all backlink entries for `target_rel`.
    ///
    /// Uses pre-resolved targets cached in `StoredLink::resolved_target`
    /// so no call to `resolve_link` is needed — O(k) where k is the number
    /// of backlinks, not O(n·k).
    pub fn get_backlinks(&self, target_rel: &str, file_index: &FileIndex) -> Vec<BacklinkEntry> {
        let sources = match self.incoming.get(target_rel) {
            Some(s) => s,
            None => return Vec::new(),
        };

        let mut entries = Vec::new();
        for source_path in sources {
            let source_title = {
                file_index
                    .all_entries()
                    .find(|(_, m)| m.relative_path == *source_path)
                    .map(|(_, m)| m.title.clone())
                    .unwrap_or_else(|| path_stem(source_path).to_string())
            };

            if let Some(stored_links) = self.outgoing.get(source_path) {
                for stored in stored_links {
                    if stored.resolved_target.as_deref() == Some(target_rel) {
                        entries.push(BacklinkEntry {
                            source_path: source_path.clone(),
                            source_title: source_title.clone(),
                            context: stored.parsed.context.clone(),
                            line_number: stored.parsed.line_number,
                        });
                    }
                }
            } else {
                entries.push(BacklinkEntry {
                    source_path: source_path.clone(),
                    source_title,
                    context: String::new(),
                    line_number: 0,
                });
            }
        }

        entries
    }

    /// Return all links across the vault that resolve to `None`.
    ///
    /// Uses pre-resolved targets cached in `StoredLink::resolved_target`
    /// so no call to `resolve_link` is needed — O(total links) instead of
    /// O(total links · total vault files).
    pub fn get_unresolved(&self) -> Vec<UnresolvedLink> {
        let mut result = Vec::new();

        for (source_path, stored_links) in &self.outgoing {
            for stored in stored_links {
                if stored.resolved_target.is_none() {
                    result.push(UnresolvedLink {
                        source_path: source_path.clone(),
                        target_raw: stored.parsed.target_raw.clone(),
                        line_number: stored.parsed.line_number,
                    });
                }
            }
        }

        result
    }
}

// ── resolved_map ───────────────────────────────────────────────────────────────

/// Build a `stem (lowercased) → vault-relative path` map for all files.
///
/// Used by `get_resolved_links` IPC command to populate the frontend's click-
/// handler map so navigation requires zero IPC at click time.
///
/// For unique stems, the single file is used directly. For ambiguous stems,
/// `resolve_link` from vault root (`""`) determines the winner (shortest path,
/// then alphabetical).
pub fn resolved_map(all_rel_paths: &[String]) -> HashMap<String, String> {
    // Group files by lowercased stem
    let mut by_stem: HashMap<String, Vec<String>> = HashMap::new();
    for p in all_rel_paths {
        let stem = path_stem(p).to_lowercase();
        by_stem.entry(stem).or_default().push(p.clone());
    }

    let mut map = HashMap::new();
    for (stem, paths) in by_stem {
        if paths.len() == 1 {
            map.insert(stem, paths.into_iter().next().unwrap());
        } else {
            // Ambiguous: use resolve_link from vault root to pick the winner
            if let Some(winner) = resolve_link(&stem, "", all_rel_paths) {
                map.insert(stem, winner);
            }
        }
    }

    map
}
