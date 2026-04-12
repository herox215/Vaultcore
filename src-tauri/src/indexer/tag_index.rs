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

// ── extract_yaml_tags ──────────────────────────────────────────────────────────

/// Extract YAML frontmatter `tags` (list OR scalar).
///
/// Returns `[]` if:
/// - The document has no frontmatter (`---` header)
/// - Frontmatter has no `tags` key
/// - The YAML is malformed (T-05-01-01 mitigation: `from_str` returns Err → `[]`)
///
/// Uses serde_yml 0.0.12 per RESEARCH Pitfall 1.
pub fn extract_yaml_tags(content: &str) -> Vec<String> {
    let stripped = content.trim_start();
    if !stripped.starts_with("---") {
        return Vec::new();
    }
    let after_first = &stripped[3..];
    let Some(end_rel) = after_first.find("\n---") else {
        return Vec::new();
    };
    let yaml_block = &after_first[..end_rel];
    let Ok(value): Result<serde_yml::Value, _> = serde_yml::from_str(yaml_block) else {
        return Vec::new();
    };
    let Some(tags_val) = value.get("tags") else {
        return Vec::new();
    };
    match tags_val {
        serde_yml::Value::Sequence(seq) => seq
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_lowercase()))
            .collect(),
        serde_yml::Value::String(s) => vec![s.to_lowercase()],
        _ => Vec::new(),
    }
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
    /// Merges inline tags + YAML frontmatter tags; deduplicates per-file.
    pub fn update_file(&mut self, rel_path: &str, content: &str) {
        // Clear previous state for this file so updates are idempotent.
        self.remove_file(rel_path);

        // Collect inline tags first, then add YAML tags (skip duplicates).
        let mut all_tags: Vec<String> = extract_inline_tags(content);
        for yt in extract_yaml_tags(content) {
            if !all_tags.contains(&yt) {
                all_tags.push(yt);
            }
        }

        // Record one occurrence per tag per file.
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
}
