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

/// Build a `key (lowercased) → vault-relative path` map that includes both
/// filename stems AND frontmatter aliases (issue #60).
///
/// Collision priority (document in code — do not change without updating
/// acceptance criteria in issue #60):
///   1. Exact filename-stem match wins over alias match. If an alias string
///      is also the stem of a different file, the stem's file is authoritative
///      and the alias never reaches the map.
///   2. Between two aliases on different notes, first-indexed wins. The loser
///      is logged at `info` — same structured-logging strategy used by
///      `resolve_link`'s stem-collision path.
///
/// `file_aliases` is a slice of `(rel_path, aliases)` pairs in whatever order
/// the `FileIndex` iterator produced. Iteration order drives alias-collision
/// resolution, matching the "first-indexed wins" rule.
pub fn resolved_map_with_aliases(
    all_rel_paths: &[String],
    file_aliases: &[(String, Vec<String>)],
) -> HashMap<String, String> {
    let stem_map = resolved_map(all_rel_paths);

    // Start from the stem map so stems always beat aliases (priority rule #1).
    let mut map = stem_map.clone();

    for (rel_path, aliases) in file_aliases {
        for alias in aliases {
            let key = alias.to_lowercase();

            // Priority 1: stem always wins. If the key is already a stem,
            // skip — stems are authoritative.
            if stem_map.contains_key(&key) {
                continue;
            }

            // Priority 2: first-indexed alias wins. Log the loser so
            // vault-health checks can surface duplicate-alias configurations
            // (same pattern as stem-collision logging in `resolve_link`).
            if let Some(existing) = map.get(&key) {
                if existing != rel_path {
                    log::info!(
                        "alias collision: '{}' already points to {}, ignoring duplicate from {}",
                        alias,
                        existing,
                        rel_path
                    );
                }
                continue;
            }

            map.insert(key, rel_path.clone());
        }
    }

    map
}

// ── Tests (#140) ──────────────────────────────────────────────────────────────
//
// Unit coverage for the pure-logic pieces of this module: link extraction,
// 3-stage resolution, incremental graph updates, and resolved_map / alias
// priority. Integration coverage still lives in `src/tests/global_graph.rs`
// and `src/tests/local_graph.rs`; these tests exist to localise failures to
// the exact function that broke (issue #140 acceptance).

#[cfg(test)]
mod tests {
    use super::*;

    // ── extract_links ──────────────────────────────────────────────────────

    #[test]
    fn extract_links_parses_plain_target() {
        let links = extract_links("See [[Note]].");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "Note");
        assert_eq!(links[0].alias, None);
        assert_eq!(links[0].line_number, 0);
    }

    #[test]
    fn extract_links_parses_alias() {
        let links = extract_links("[[Target|Display Alias]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "Target");
        assert_eq!(links[0].alias.as_deref(), Some("Display Alias"));
    }

    #[test]
    fn extract_links_keeps_heading_as_part_of_target() {
        // We don't split on `#` at extract time — the resolver handles the
        // stem vs heading split downstream. Lock this in: `[[Note#Heading]]`
        // surfaces as target_raw "Note#Heading".
        let links = extract_links("[[Note#Section]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "Note#Section");
    }

    #[test]
    fn extract_links_triple_pipe_only_takes_first_alias_segment() {
        // `[[a|b|c]]` is malformed; the regex lazy-matches `[^\]]*` for the
        // alias, so it captures everything after the first pipe up to `]]`.
        // Document the observed behavior — don't crash on it.
        let links = extract_links("[[a|b|c]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_raw, "a");
        assert_eq!(links[0].alias.as_deref(), Some("b|c"));
    }

    #[test]
    fn extract_links_does_not_split_on_escaped_brackets() {
        // Escape sequences inside wiki-links are not supported by Obsidian
        // or by this extractor. A `\]` in the target is treated as the
        // closing bracket by the regex: `[^\]|]+?` stops at `]` regardless.
        // Just confirm we don't panic and we don't over-capture.
        let links = extract_links("[[weird\\]stuff]]");
        // Regex won't match — target contained `]` before the closing `]]`.
        // Asserting zero matches pins down the escape-free contract.
        assert!(links.is_empty());
    }

    #[test]
    fn extract_links_ignores_single_brackets() {
        // Markdown `[link](url)` must not be picked up as a wiki-link.
        let links = extract_links("See [link](http://x) and [ref][1].");
        assert!(links.is_empty());
    }

    #[test]
    fn extract_links_does_not_exclude_code_fences() {
        // Intentional per module docs: Rust indexes ALL links for graph
        // completeness; CM6 suppresses visuals in code fences on the FE.
        let md = "```\n[[Inside]]\n```\n[[Outside]]";
        let links = extract_links(md);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].target_raw, "Inside");
        assert_eq!(links[1].target_raw, "Outside");
    }

    #[test]
    fn extract_links_records_line_numbers() {
        let md = "line0\n[[A]]\nline2\n[[B]]";
        let links = extract_links(md);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].line_number, 1);
        assert_eq!(links[1].line_number, 3);
    }

    // ── resolve_link ───────────────────────────────────────────────────────

    #[test]
    fn resolve_link_prefers_same_folder_match() {
        // Stage 1: same-folder wins over shallower candidates elsewhere.
        let paths = vec![
            "Root.md".to_string(),
            "folder/Root.md".to_string(),
        ];
        let resolved = resolve_link("Root", "folder/", &paths);
        assert_eq!(resolved.as_deref(), Some("folder/Root.md"));
    }

    #[test]
    fn resolve_link_prefers_shortest_path_when_no_same_folder_hit() {
        // Stage 2: depth-0 candidate wins over depth-2.
        let paths = vec![
            "deep/sub/Note.md".to_string(),
            "Note.md".to_string(),
        ];
        let resolved = resolve_link("Note", "unrelated/", &paths);
        assert_eq!(resolved.as_deref(), Some("Note.md"));
    }

    #[test]
    fn resolve_link_alphabetical_tiebreak_on_equal_depth() {
        // Stage 3: both candidates depth 1, alphabetical wins.
        let paths = vec![
            "zeta/Note.md".to_string(),
            "alpha/Note.md".to_string(),
        ];
        let resolved = resolve_link("Note", "unrelated/", &paths);
        assert_eq!(resolved.as_deref(), Some("alpha/Note.md"));
    }

    #[test]
    fn resolve_link_strips_dot_md_suffix_from_query() {
        let paths = vec!["Note.md".to_string()];
        let resolved = resolve_link("Note.md", "", &paths);
        assert_eq!(resolved.as_deref(), Some("Note.md"));
    }

    #[test]
    fn resolve_link_is_case_insensitive() {
        let paths = vec!["Note.md".to_string()];
        let resolved = resolve_link("NOTE", "", &paths);
        assert_eq!(resolved.as_deref(), Some("Note.md"));
    }

    #[test]
    fn resolve_link_returns_none_for_missing_target() {
        let paths = vec!["Other.md".to_string()];
        assert!(resolve_link("Missing", "", &paths).is_none());
    }

    // ── LinkGraph incremental semantics ────────────────────────────────────

    fn parsed(target: &str, line: u32) -> ParsedLink {
        ParsedLink {
            target_raw: target.to_string(),
            alias: None,
            line_number: line,
            context: format!("[[{}]]", target),
        }
    }

    #[test]
    fn link_graph_update_then_remove_returns_to_empty_state() {
        let mut g = LinkGraph::new();
        let paths = vec!["src.md".to_string(), "dst.md".to_string()];
        g.update_file("src.md", vec![parsed("dst", 0)], &paths);

        assert_eq!(g.backlink_count("dst.md"), 1);
        assert!(g.outgoing_for("src.md").is_some());

        g.remove_file("src.md");
        assert_eq!(g.backlink_count("dst.md"), 0);
        assert!(g.outgoing_for("src.md").is_none());
        // Internal `incoming` map should drop the emptied entry entirely
        // (see retain in remove_file).
        assert!(g.incoming_for("dst.md").is_none());
    }

    #[test]
    fn link_graph_update_is_idempotent_for_same_source() {
        let mut g = LinkGraph::new();
        let paths = vec!["src.md".to_string(), "dst.md".to_string()];
        g.update_file("src.md", vec![parsed("dst", 0)], &paths);
        g.update_file("src.md", vec![parsed("dst", 0)], &paths);

        // Second update must replace, not append — a single incoming entry.
        assert_eq!(g.backlink_count("dst.md"), 1);
        let out = g.outgoing_for("src.md").unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn link_graph_replaces_target_when_source_is_retargeted() {
        let mut g = LinkGraph::new();
        let paths = vec!["src.md".to_string(), "a.md".to_string(), "b.md".to_string()];
        g.update_file("src.md", vec![parsed("a", 0)], &paths);
        assert_eq!(g.backlink_count("a.md"), 1);
        assert_eq!(g.backlink_count("b.md"), 0);

        g.update_file("src.md", vec![parsed("b", 0)], &paths);
        assert_eq!(g.backlink_count("a.md"), 0);
        assert_eq!(g.backlink_count("b.md"), 1);
    }

    #[test]
    fn link_graph_surfaces_unresolved_without_panic() {
        let mut g = LinkGraph::new();
        let paths = vec!["src.md".to_string()];
        g.update_file("src.md", vec![parsed("ghost", 2)], &paths);

        let unresolved = g.get_unresolved();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].source_path, "src.md");
        assert_eq!(unresolved[0].target_raw, "ghost");
        assert_eq!(unresolved[0].line_number, 2);
        // backlink_count on a never-linked target is 0, not a panic.
        assert_eq!(g.backlink_count("nobody.md"), 0);
    }

    // ── resolved_map + aliases ─────────────────────────────────────────────

    #[test]
    fn resolved_map_disambiguates_on_collision() {
        // Two files share stem "note". Shortest-path wins; then alphabetical.
        let paths = vec![
            "deep/sub/note.md".to_string(),
            "a/note.md".to_string(),
            "b/note.md".to_string(),
        ];
        let map = resolved_map(&paths);
        assert_eq!(map.get("note").map(String::as_str), Some("a/note.md"));
    }

    #[test]
    fn resolved_map_with_aliases_stem_beats_alias() {
        // Priority rule #1: a file's stem always wins over another file's
        // alias that happens to collide with that stem.
        let paths = vec!["Real.md".to_string(), "Other.md".to_string()];
        let file_aliases = vec![
            ("Other.md".to_string(), vec!["Real".to_string()]),
        ];
        let map = resolved_map_with_aliases(&paths, &file_aliases);
        // "real" (stem) must point at Real.md, not Other.md via alias.
        assert_eq!(map.get("real").map(String::as_str), Some("Real.md"));
    }

    #[test]
    fn resolved_map_with_aliases_first_indexed_alias_wins() {
        // Priority rule #2: when two different files claim the same alias
        // and neither matches a stem, the first-seen wins.
        let paths = vec!["A.md".to_string(), "B.md".to_string()];
        let file_aliases = vec![
            ("A.md".to_string(), vec!["shared".to_string()]),
            ("B.md".to_string(), vec!["shared".to_string()]),
        ];
        let map = resolved_map_with_aliases(&paths, &file_aliases);
        assert_eq!(map.get("shared").map(String::as_str), Some("A.md"));
    }
}
