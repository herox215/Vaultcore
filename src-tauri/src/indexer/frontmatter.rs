// Shared YAML frontmatter reader.
//
// Extracted from `tag_index.rs`'s original `extract_yaml_tags` so that the
// same parser can service the `tags:` key and the new `aliases:` key without
// duplicating the `---` delimiter logic, the empty-frontmatter guard, or the
// malformed-YAML fallback.
//
// Behaviour (unchanged from the original):
// - Returns `None` for any document without a leading `---\n…\n---` block.
// - Returns `None` (i.e. the key was absent) and an empty vector for malformed
//   YAML so the caller degrades gracefully. Tests cover this explicitly.
// - Both list form (`tags: [a, b]`) and scalar form (`tags: a`) are accepted.
//
// Serde behaviour mirrors the `serde_yml` 0.0.12 semantics already in use by
// `tag_index.rs` — see the original pitfall note about version selection.

use serde_yml::Value;

/// Parsed frontmatter keys the indexer cares about.
///
/// Only surfaces the *recognised* keys; the parser is not a full `serde_yml`
/// roundtrip. Keys absent from the source file collapse to empty `Vec`s so
/// the caller doesn't have to distinguish missing-vs-empty.
///
/// Strings inside each vector are lowercased for case-insensitive matching
/// (same contract as `extract_yaml_tags` / `extract_inline_tags`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
}

/// Extract the raw YAML text between the leading `---` delimiters of a
/// frontmatter block. Returns `None` if no well-formed delimiter pair exists.
///
/// Splitting out this step (vs. running the full YAML parse first) keeps the
/// fast-path free — 99% of Markdown files have no frontmatter and can be
/// rejected after one `starts_with` check and one `find`.
fn frontmatter_yaml_block(content: &str) -> Option<&str> {
    let stripped = content.trim_start();
    if !stripped.starts_with("---") {
        return None;
    }
    let after_first = &stripped[3..];
    let end_rel = after_first.find("\n---")?;
    Some(&after_first[..end_rel])
}

/// Read a single key from a parsed YAML value, accepting either a list of
/// scalars or a single scalar string. Other node shapes (maps, nested seqs,
/// booleans, …) collapse to an empty vector — same contract as the original
/// `extract_yaml_tags`.
fn read_string_seq_or_scalar(value: &Value, key: &str) -> Vec<String> {
    match value.get(key) {
        Some(Value::Sequence(seq)) => seq
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_lowercase()))
            .collect(),
        Some(Value::String(s)) => vec![s.to_lowercase()],
        _ => Vec::new(),
    }
}

/// Parse a Markdown document's YAML frontmatter and return the recognised
/// keys. Returns `Frontmatter::default()` (all empty) when there is no
/// frontmatter block or the YAML fails to parse.
pub fn parse_frontmatter(content: &str) -> Frontmatter {
    let Some(yaml_block) = frontmatter_yaml_block(content) else {
        return Frontmatter::default();
    };
    let Ok(value): Result<Value, _> = serde_yml::from_str(yaml_block) else {
        return Frontmatter::default();
    };

    Frontmatter {
        tags: read_string_seq_or_scalar(&value, "tags"),
        aliases: read_string_seq_or_scalar(&value, "aliases"),
    }
}

/// Back-compat helper matching the original `extract_yaml_tags` signature —
/// kept so `tag_index.rs` can delegate without touching its public API.
pub fn extract_yaml_tags(content: &str) -> Vec<String> {
    parse_frontmatter(content).tags
}

/// Frontmatter `aliases:` helper (list or scalar form).
///
/// Order is preserved, values are lowercased; duplicates are NOT deduped here
/// because callers may want to surface the raw list verbatim.
pub fn extract_yaml_aliases(content: &str) -> Vec<String> {
    parse_frontmatter(content).aliases
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Tag back-compat — mirrors the original tag_index.rs tests ──────────────

    #[test]
    fn tags_list_form() {
        let content = "---\ntags: [a, b, nested/tag]\n---\nbody";
        assert_eq!(extract_yaml_tags(content), vec!["a", "b", "nested/tag"]);
    }

    #[test]
    fn tags_scalar_form() {
        let content = "---\ntags: single\n---\n...";
        assert_eq!(extract_yaml_tags(content), vec!["single"]);
    }

    #[test]
    fn tags_absent_key() {
        let content = "---\ntitle: foo\n---\n...";
        assert!(extract_yaml_tags(content).is_empty());
    }

    #[test]
    fn tags_no_frontmatter() {
        let content = "no dashes\ntags: [a]";
        assert!(extract_yaml_tags(content).is_empty());
    }

    // ── Alias behaviour ────────────────────────────────────────────────────────

    #[test]
    fn aliases_list_form() {
        let content = "---\naliases: [UI, User Interface]\n---\nbody";
        assert_eq!(extract_yaml_aliases(content), vec!["ui", "user interface"]);
    }

    #[test]
    fn aliases_scalar_form() {
        let content = "---\naliases: UI\n---\nbody";
        assert_eq!(extract_yaml_aliases(content), vec!["ui"]);
    }

    #[test]
    fn aliases_absent_key_returns_empty() {
        let content = "---\ntitle: foo\n---\nbody";
        assert!(extract_yaml_aliases(content).is_empty());
    }

    #[test]
    fn malformed_yaml_degrades_to_empty() {
        // Unbalanced bracket — serde_yml::from_str returns Err → default.
        let content = "---\naliases: [UI, User Interface\n---\nbody";
        let fm = parse_frontmatter(content);
        assert!(fm.aliases.is_empty());
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn combined_keys_are_both_parsed() {
        let content = "---\ntags: [rust]\naliases: [UI, Interface]\n---\nbody";
        let fm = parse_frontmatter(content);
        assert_eq!(fm.tags, vec!["rust"]);
        assert_eq!(fm.aliases, vec!["ui", "interface"]);
    }

    #[test]
    fn aliases_non_string_node_is_empty() {
        // A nested mapping is not a scalar/sequence of strings.
        let content = "---\naliases:\n  nested: value\n---\nbody";
        let fm = parse_frontmatter(content);
        assert!(fm.aliases.is_empty());
    }

    #[test]
    fn empty_frontmatter_block_is_empty() {
        let content = "---\n---\nbody";
        let fm = parse_frontmatter(content);
        assert!(fm.tags.is_empty());
        assert!(fm.aliases.is_empty());
    }
}
