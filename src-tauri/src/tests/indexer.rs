// Tests for the indexer module: parser, memory, and tantivy_index helpers.
// These are the unit tests specified in the Task 2 TDD behavior block.

#[cfg(test)]
mod parser_tests {
    use crate::indexer::parser::strip_markdown;

    #[test]
    fn strip_markdown_heading_and_bold() {
        // "# Hello **world**" → "Hello world"
        assert_eq!(strip_markdown("# Hello **world**"), "Hello world");
    }

    #[test]
    fn strip_markdown_empty() {
        assert_eq!(strip_markdown(""), "");
    }

    #[test]
    fn strip_markdown_code_fence() {
        // Code block content is kept; fences are dropped.
        let result = strip_markdown("```rust\nfn main() {}\n```");
        assert_eq!(result.trim(), "fn main() {}");
    }
}

#[cfg(test)]
mod memory_tests {
    use crate::indexer::memory::{FileIndex, FileMeta};
    use std::path::PathBuf;

    fn meta(rel: &str) -> FileMeta {
        FileMeta {
            relative_path: rel.to_string(),
            hash: "deadbeef".to_string(),
            title: rel.to_string(),
        }
    }

    #[test]
    fn insert_get_remove_round_trip() {
        let mut idx = FileIndex::new();
        let path = PathBuf::from("/vault/note.md");
        idx.insert(path.clone(), meta("note.md"));
        assert!(idx.get(&path).is_some());
        assert!(idx.remove(&path).is_some());
        assert!(idx.get(&path).is_none());
    }

    #[test]
    fn all_relative_paths_returns_inserted_paths() {
        let mut idx = FileIndex::new();
        idx.insert(PathBuf::from("/vault/a.md"), meta("a.md"));
        idx.insert(PathBuf::from("/vault/b.md"), meta("b.md"));
        let mut paths = idx.all_relative_paths();
        paths.sort();
        assert_eq!(paths, vec!["a.md", "b.md"]);
    }
}

#[cfg(test)]
mod tantivy_index_tests {
    use crate::indexer::tantivy_index::{check_version, extract_title, write_version};
    use tempfile::TempDir;

    #[test]
    fn extract_title_finds_h1() {
        assert_eq!(extract_title("# My Title\nBody", "fallback"), "My Title");
    }

    #[test]
    fn extract_title_fallback_when_no_heading() {
        assert_eq!(extract_title("No heading here", "fallback"), "fallback");
    }

    #[test]
    fn check_version_false_for_missing_file() {
        let dir = TempDir::new().unwrap();
        assert!(!check_version(dir.path()));
    }

    #[test]
    fn write_version_then_check_version_returns_true() {
        let dir = TempDir::new().unwrap();
        write_version(dir.path()).unwrap();
        assert!(check_version(dir.path()));
    }
}
