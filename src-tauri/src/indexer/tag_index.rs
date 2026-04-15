//! Tag index — inline #tag + YAML frontmatter `tags:` extraction.
//!
//! Mirrors `link_graph.rs` architecture (RESEARCH Pattern 1): OnceLock<Regex>,
//! update_file / remove_file, Arc<Mutex<Self>> storage in IndexCoordinator.
//!
//! Code-block exclusion is INTENTIONALLY NOT done here (RESEARCH Pitfall 6,
//! same trade-off as LinkGraph). `#include` in a fenced C block WILL appear
//! as a tag; accepted per CONTEXT.md Out-of-Scope.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

// ── Compiled regex ─────────────────────────────────────────────────────────────

fn inline_tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Preceding char must be whitespace/punctuation or line-start; first tag
        // char must be a letter (filters #123 and URL-fragment false positives).
        Regex::new(r"(?:^|[\s(,!?;:])#([a-zA-Z][a-zA-Z0-9_\-/]*)").expect("invalid tag regex")
    })
}

// ── Public structs ─────────────────────────────────────────────────────────────

/// A single occurrence of a tag in a note file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagOccurrence {
    /// Vault-relative path of the file that contains the tag.
    pub source_rel_path: String,
    /// 0-based line number where the tag appears (0 for YAML frontmatter tags).
    pub line_number: u32,
}

/// Aggregate usage entry for a tag — returned by `list_tags`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagUsage {
    /// The tag string (lowercased, without the `#` prefix).
    pub tag: String,
    /// Number of files that contain this tag (not total occurrences).
    pub count: usize,
}

// ── extract_inline_tags ────────────────────────────────────────────────────────

/// Extract inline tags (fast-path: skip regex if no '#' per LinkGraph convention).
///
/// Result is first-occurrence-ordered, lowercased, deduplicated within a single file.
/// Tags must start with a letter (filters `#123` and URL-fragment false positives).
/// Preceding character must be whitespace/punctuation or start-of-line.
pub fn extract_inline_tags(content: &str) -> Vec<String> {
    if !content.contains('#') {
        return Vec::new();
    }
    let re = inline_tag_regex();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut result = Vec::new();
    for cap in re.captures_iter(content) {
        if let Some(m) = cap.get(1) {
            let t = m.as_str().to_lowercase();
            if seen.insert(t.clone()) {
                result.push(t);
            }
        }
    }
    result
}

/// Extract EVERY occurrence of an inline tag (duplicates preserved, lowercased).
///
/// Used by `TagIndex::update_file` to compute total-occurrence counts — user UAT
/// feedback (05.1): `#test` written 3× in one file should surface as `test (3)`,
/// not `test (1)`. The per-file dedup form stays available via `extract_inline_tags`
/// for callers that need it.
pub fn extract_inline_tag_occurrences(content: &str) -> Vec<String> {
    if !content.contains('#') {
        return Vec::new();
    }
    let re = inline_tag_regex();
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_lowercase()))
        .collect()
}

// ── extract_yaml_tags ──────────────────────────────────────────────────────────

/// Extract YAML frontmatter `tags` (list OR scalar).
///
/// Returns `[]` if:
/// - The document has no frontmatter (`---` header)
/// - Frontmatter has no `tags` key
/// - The YAML is malformed (T-05-01-01 mitigation: `from_str` returns Err → `[]`)
///
/// Delegates to the shared frontmatter reader (`super::frontmatter`). Public
/// contract is semantically identical to the pre-refactor implementation —
/// existing tag tests still exercise this code path.
pub fn extract_yaml_tags(content: &str) -> Vec<String> {
    super::frontmatter::extract_yaml_tags(content)
}

// ── TagIndex ───────────────────────────────────────────────────────────────────

/// In-memory tag adjacency index.
///
/// `occurrences`: tag (lowercased) → Vec of TagOccurrence (one per file that has the tag).
/// `by_file`: vault-relative path → Vec of tags contained in that file.
///
/// Per-file uniqueness is enforced: the same tag in one file is counted once,
/// regardless of how many times it appears (inline vs YAML duplicates).
#[derive(Debug, Default)]
pub struct TagIndex {
    /// tag → list of occurrences (one per file)
    occurrences: HashMap<String, Vec<TagOccurrence>>,
    /// file → list of tags it contains (for efficient removal)
    by_file: HashMap<String, Vec<String>>,
}

impl TagIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Update (or insert) all tags for `rel_path`.
    ///
    /// Idempotent: calling twice for the same file replaces the previous entries.
    /// BUG-05.1 FIXES:
    /// - YAML frontmatter tag extraction (TAG-02) descoped per user UAT feedback.
    ///   Only inline `#tag` / `#parent/child` tags are collected. `extract_yaml_tags`
    ///   remains in the module as dead code for future re-enablement.
    /// - Counts are now total-occurrence (not per-file unique). Writing `#test` three
    ///   times in one file yields `test (3)` in the tag panel — matches user expectation.
    pub fn update_file(&mut self, rel_path: &str, content: &str) {
        // Clear previous state for this file so updates are idempotent.
        self.remove_file(rel_path);

        let all_tags: Vec<String> = extract_inline_tag_occurrences(content);

        // Record one occurrence per tag match (duplicates preserved for count).
        for t in &all_tags {
            self.occurrences
                .entry(t.clone())
                .or_default()
                .push(TagOccurrence {
                    source_rel_path: rel_path.to_string(),
                    line_number: 0,
                });
        }

        self.by_file.insert(rel_path.to_string(), all_tags);
    }

    /// Remove all tag information for `rel_path`.
    pub fn remove_file(&mut self, rel_path: &str) {
        if let Some(tags) = self.by_file.remove(rel_path) {
            for t in tags {
                if let Some(list) = self.occurrences.get_mut(&t) {
                    list.retain(|o| o.source_rel_path != rel_path);
                    if list.is_empty() {
                        self.occurrences.remove(&t);
                    }
                }
            }
        }
    }

    /// Return all tags sorted alphabetically with their file-occurrence counts.
    pub fn list_tags(&self) -> Vec<TagUsage> {
        let mut v: Vec<TagUsage> = self
            .occurrences
            .iter()
            .map(|(tag, occs)| TagUsage {
                tag: tag.clone(),
                count: occs.len(),
            })
            .collect();
        v.sort_by(|a, b| a.tag.cmp(&b.tag));
        v
    }

    /// Return all occurrences of a specific tag (case-insensitive lookup).
    pub fn get_occurrences(&self, tag: &str) -> Vec<TagOccurrence> {
        self.occurrences
            .get(&tag.to_lowercase())
            .cloned()
            .unwrap_or_default()
    }

    /// Return the deduplicated, sorted list of tags for `rel_path`.
    ///
    /// `by_file` stores per-file tag occurrences with duplicates (needed for
    /// the "three hits of #test" count). The graph view only cares whether a
    /// tag is present — dedupe + sort for stable output.
    pub fn tags_for_file(&self, rel_path: &str) -> Vec<String> {
        let Some(tags) = self.by_file.get(rel_path) else {
            return Vec::new();
        };
        let mut uniq: Vec<String> = {
            let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
            tags.iter()
                .filter(|t| seen.insert(t.as_str()))
                .cloned()
                .collect()
        };
        uniq.sort();
        uniq
    }
}
