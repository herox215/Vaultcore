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
            aliases: Vec::new(),
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

// ─── Orphan cleanup on vault open (issue #46) ────────────────────────────────
//
// These tests exercise `IndexCoordinator::new`'s automatic `DeleteAll`
// dispatch. They send `AddFile`/`Commit` commands directly through the
// coordinator's mpsc channel — the same path `index_vault` takes — so the
// tests don't need a `tauri::AppHandle` just to observe that orphans from a
// prior session are gone after the coordinator is re-opened.
#[cfg(test)]
mod orphan_cleanup_tests {
    use std::path::Path;
    use std::time::Duration;

    use tantivy::collector::Count;
    use tantivy::query::TermQuery;
    use tantivy::schema::{IndexRecordOption, Value};
    use tantivy::{Index, IndexReader, TantivyDocument, Term};
    use tempfile::TempDir;

    use crate::indexer::{IndexCmd, IndexCoordinator};

    /// Index a single "file" by dispatching AddFile + Commit through `tx`.
    /// Mirrors what `index_vault` does per-file without requiring an AppHandle.
    async fn add_and_commit(
        coord: &IndexCoordinator,
        abs_path: &Path,
        title: &str,
        body: &str,
    ) {
        coord
            .tx
            .send(IndexCmd::AddFile {
                path: abs_path.to_path_buf(),
                title: title.to_string(),
                body: body.to_string(),
                hash: "test-hash".to_string(),
            })
            .await
            .expect("AddFile send");
        coord.tx.send(IndexCmd::Commit).await.expect("Commit send");
    }

    /// Block until the writer task has drained every enqueued command. The
    /// writer processes commands strictly in order, so once a round-trip
    /// probe command (here: a second Commit) completes, everything queued
    /// before it is guaranteed to have been applied and the reader reloaded.
    async fn wait_for_drain(coord: &IndexCoordinator) {
        // The channel has capacity 1024, so we can't rely on backpressure.
        // Instead: poll `reader.searcher().num_docs()` stability — it goes
        // up on each Commit the writer processes. We send a no-op Commit and
        // wait briefly, which is enough for the writer's `ReloadPolicy::
        // OnCommitWithDelay` (default 100ms) to publish the new view.
        coord
            .tx
            .send(IndexCmd::Commit)
            .await
            .expect("drain Commit send");
        // OnCommitWithDelay is ~100ms — give it a comfortable margin so the
        // reader.reload() inside the writer task definitely lands before we
        // query num_docs.
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    fn path_hits(index: &Index, reader: &IndexReader, path_str: &str) -> usize {
        let schema = index.schema();
        let path_field = schema.get_field("path").expect("path field");
        let term = Term::from_field_text(path_field, path_str);
        let query = TermQuery::new(term, IndexRecordOption::Basic);
        let searcher = reader.searcher();
        searcher.search(&query, &Count).expect("search")
    }

    fn total_docs(reader: &IndexReader) -> u64 {
        reader.searcher().num_docs()
    }

    /// Retrieve the stored `path` values of all live documents. Useful for
    /// asserting what survives after `DeleteAll` + partial re-add.
    fn all_paths(index: &Index, reader: &IndexReader) -> Vec<String> {
        let schema = index.schema();
        let path_field = schema.get_field("path").expect("path field");
        let searcher = reader.searcher();
        let mut out = Vec::new();
        for reader_segment in searcher.segment_readers() {
            let store = reader_segment
                .get_store_reader(10)
                .expect("store reader");
            for doc_id in 0..reader_segment.max_doc() {
                if reader_segment.is_deleted(doc_id) {
                    continue;
                }
                let doc: TantivyDocument = store.get(doc_id).expect("store get");
                if let Some(v) = doc.get_first(path_field).and_then(|v| v.as_str()) {
                    out.push(v.to_string());
                }
            }
        }
        out.sort();
        out
    }

    #[tokio::test]
    async fn fresh_coordinator_drops_orphan_docs_from_previous_session() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path();

        let a_path = vault.join("a.md");
        let b_path = vault.join("b.md");
        std::fs::write(&a_path, "# A\nalpha body").unwrap();
        std::fs::write(&b_path, "# B\nbravo body").unwrap();

        // ── Session 1: index both files ──
        {
            let coord = IndexCoordinator::new(vault).expect("coordinator 1");
            add_and_commit(&coord, &a_path, "A", "alpha body").await;
            add_and_commit(&coord, &b_path, "B", "bravo body").await;
            wait_for_drain(&coord).await;

            assert_eq!(
                path_hits(&coord.index, &coord.reader, &a_path.to_string_lossy()),
                1,
                "a.md should be indexed in session 1"
            );
            assert_eq!(
                path_hits(&coord.index, &coord.reader, &b_path.to_string_lossy()),
                1,
                "b.md should be indexed in session 1"
            );
            assert_eq!(total_docs(&coord.reader), 2, "two live docs after session 1");
            // Coordinator drops here — Drop sends Shutdown; the writer commits
            // and releases the directory write lock before the next `new`.
        }

        // Simulate the vault mutation that happens between sessions.
        std::fs::remove_file(&b_path).unwrap();

        // Give the previous writer task a moment to process Shutdown and drop
        // its IndexWriter. In production, Drop + channel close already serialises
        // this; the sleep just keeps the test deterministic across schedulers.
        tokio::time::sleep(Duration::from_millis(200)).await;

        // ── Session 2: new coordinator, only a.md gets re-added ──
        let coord2 = IndexCoordinator::new(vault).expect("coordinator 2");
        // IndexCoordinator::new already enqueued DeleteAll. Now mirror what
        // index_vault does when b.md is missing from disk: only a.md lands.
        add_and_commit(&coord2, &a_path, "A", "alpha body").await;
        wait_for_drain(&coord2).await;

        let surviving = all_paths(&coord2.index, &coord2.reader);
        assert_eq!(
            surviving,
            vec![a_path.to_string_lossy().into_owned()],
            "only a.md should survive — b.md was an orphan"
        );
        assert_eq!(
            path_hits(&coord2.index, &coord2.reader, &b_path.to_string_lossy()),
            0,
            "b.md (deleted from disk) must not return ghost hits"
        );
    }

    #[tokio::test]
    async fn fresh_coordinator_on_empty_vault_is_noop_safe() {
        // DeleteAll on a brand-new empty index must succeed silently. This
        // guards against any regression where DeleteAll fails on an index
        // that has zero segments.
        let tmp = TempDir::new().unwrap();
        let coord = IndexCoordinator::new(tmp.path()).expect("coordinator");
        wait_for_drain(&coord).await;
        assert_eq!(total_docs(&coord.reader), 0);
    }
}
