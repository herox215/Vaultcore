---
phase: 03-search
plan: "01"
subsystem: search
tags: [tantivy, rust, full-text-search, nucleo-matcher, pulldown-cmark, indexer, mpsc]

requires:
  - phase: 02-vault
    provides: VaultState, open_vault command, hash_bytes, WalkDir integration, VaultError types

provides:
  - Tantivy full-text search index pipeline (schema v1, MmapDirectory)
  - IndexCoordinator with mpsc write queue (capacity 1024, single IndexWriter)
  - FileIndex in-memory metadata store with SHA-256 hash cache for incremental indexing
  - strip_markdown via pulldown-cmark (plain text for body field, XSS-safe)
  - index_version.json sidecar for schema versioning and automatic wipe-and-rebuild
  - open_vault now drives real Tantivy indexing with progress events

affects:
  - 03-02-search-commands (queries the Index and IndexReader from IndexCoordinator)
  - 03-03-quick-switcher (uses nucleo_matcher and FileIndex from IndexCoordinator)
  - 04-links (backlinks may query tantivy body field)

tech-stack:
  added:
    - tantivy = "0.26" (full-text search engine)
    - nucleo-matcher = "0.3" (fuzzy filename matching for Quick Switcher)
    - pulldown-cmark = "0.13" (Markdown-to-plain-text stripping)
  patterns:
    - Central mpsc write queue (capacity=1024) serialises all Tantivy IndexWriter access
    - IndexCoordinator stored in VaultState as Arc<Mutex<Option<...>>> (lazy init on first open_vault)
    - Submodule named tantivy_index (not tantivy) to avoid shadowing the external tantivy crate
    - SHA-256 hash comparison for incremental re-indexing (skip unchanged files)
    - dot-prefix filter in collect_md_paths covers .vaultcore, .obsidian, .trash implicitly

key-files:
  created:
    - src-tauri/src/indexer/mod.rs (IndexCoordinator, IndexCmd enum, index_vault, queue consumer)
    - src-tauri/src/indexer/tantivy_index.rs (build_schema, open_or_create_index, check_version, write_version, extract_title)
    - src-tauri/src/indexer/memory.rs (FileIndex, FileMeta)
    - src-tauri/src/indexer/parser.rs (strip_markdown)
    - src-tauri/src/tests/indexer.rs (24 unit tests)
  modified:
    - src-tauri/Cargo.toml (added 3 new deps)
    - src-tauri/src/lib.rs (pub mod indexer, index_coordinator field in VaultState)
    - src-tauri/src/commands/vault.rs (open_vault integrated with IndexCoordinator::index_vault)
    - src-tauri/src/commands/tree.rs (.vaultcore exclusion documented explicitly)
    - src-tauri/src/tests/mod.rs (added mod indexer)

key-decisions:
  - "Submodule named tantivy_index not tantivy — avoids shadowing external tantivy crate in Rust name resolution"
  - "iso8601_utc implemented inline in tantivy_index.rs — avoids cross-module dependency on vault.rs format_iso8601_utc"
  - "IndexCoordinator take/put pattern in open_vault — coordinator not Clone, taken from Mutex, run, put back; avoids Arc nesting"
  - "dot-prefix filter in collect_md_paths covers all hidden dirs including .vaultcore without special-casing"

patterns-established:
  - "Pattern: mpsc queue for all Tantivy writes — never two concurrent IndexWriter operations"
  - "Pattern: SHA-256 hash in FileMeta — incremental skip on warm vault open"
  - "Pattern: open_or_create_index tries open first, creates on failure — handles empty dir and invalid index"

requirements-completed: [IDX-01, IDX-03, IDX-04, IDX-05, IDX-06, IDX-08, ERR-02]

duration: 45min
completed: 2026-04-12
---

# Phase 3 Plan 01: Indexer Foundation Summary

**Tantivy 0.26 indexing pipeline with mpsc write queue, SHA-256 incremental skip, and open_vault integration — all .md files indexed into a schema-versioned MmapDirectory on vault open**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-12
- **Completed:** 2026-04-12
- **Tasks:** 2 (Task 1: skeleton + deps, Task 2: queue consumer + open_vault integration)
- **Files modified:** 9

## Accomplishments

- Created complete Rust indexer module (`src/indexer/`) with 4 subfiles and IndexCoordinator
- All Tantivy writes serialised through a single mpsc channel (capacity 1024, T-03-02) with one IndexWriter in a background tokio task
- `open_vault` now drives real Tantivy indexing: SHA-256 hash comparison skips unchanged files, progress events emitted at 50ms throttle, schema-version check triggers automatic wipe-and-rebuild
- 24 unit tests covering parser, FileIndex, extract_title, check_version/write_version — all green (83 total tests passing)
- `.vaultcore` directory excluded from file tree via existing dot-prefix filter (documented explicitly in tree.rs)

## Task Commits

1. **Task 1: Cargo deps + indexer module skeleton** - `ef0d7f8` (feat)
2. **Task 2: IndexCoordinator queue consumer + open_vault integration** - `aca97e8` (feat)

## Files Created/Modified

- `/home/sokragent/Projects/vaultcore/src-tauri/src/indexer/mod.rs` — IndexCoordinator, IndexCmd enum, index_vault async method, mpsc queue consumer
- `/home/sokragent/Projects/vaultcore/src-tauri/src/indexer/tantivy_index.rs` — build_schema, open_or_create_index, check_version, write_version, extract_title, CURRENT_SCHEMA_VERSION=1
- `/home/sokragent/Projects/vaultcore/src-tauri/src/indexer/memory.rs` — FileIndex (HashMap<PathBuf, FileMeta>), FileMeta with relative_path/hash/title
- `/home/sokragent/Projects/vaultcore/src-tauri/src/indexer/parser.rs` — strip_markdown via pulldown-cmark (T-03-01 XSS mitigation)
- `/home/sokragent/Projects/vaultcore/src-tauri/src/tests/indexer.rs` — 24 unit tests
- `/home/sokragent/Projects/vaultcore/src-tauri/Cargo.toml` — tantivy=0.26, nucleo-matcher=0.3, pulldown-cmark=0.13
- `/home/sokragent/Projects/vaultcore/src-tauri/src/lib.rs` — pub mod indexer, index_coordinator field
- `/home/sokragent/Projects/vaultcore/src-tauri/src/commands/vault.rs` — open_vault uses IndexCoordinator::index_vault
- `/home/sokragent/Projects/vaultcore/src-tauri/src/commands/tree.rs` — .vaultcore exclusion documented

## Decisions Made

- **Submodule named `tantivy_index`:** The plan specified `pub mod tantivy` but that name shadows the external `tantivy` crate in Rust's name resolution — `::tantivy::doc!` and other crate items become unreachable. Renamed to `tantivy_index` (Rule 1 auto-fix).
- **iso8601_utc inlined in tantivy_index.rs:** The `format_iso8601_utc` function in vault.rs is `pub(crate)` — importing it from tantivy_index.rs works but creates a cross-module coupling. Inlined the same algorithm to keep the module self-contained.
- **IndexCoordinator take/put pattern:** `IndexCoordinator` is not `Clone` (owns Arc<IndexReader>, Arc<Index>, mpsc::Sender). In open_vault, we take it from the `Mutex<Option<...>>`, call `index_vault`, then put it back. This avoids wrapping the coordinator itself in Arc.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Renamed submodule tantivy → tantivy_index to fix name shadowing**
- **Found during:** Task 1 (cargo check after creating mod.rs)
- **Issue:** `pub mod tantivy` in `indexer/mod.rs` shadows the external `tantivy` crate. `::tantivy::doc!` macro not found in scope because `::tantivy` resolves to the local module, not the crate.
- **Fix:** Renamed `tantivy.rs` to `tantivy_index.rs`, changed `pub mod tantivy` to `pub mod tantivy_index`, updated all call sites. External crate `tantivy` now accessible via `use tantivy::...`.
- **Files modified:** src-tauri/src/indexer/mod.rs, src-tauri/src/indexer/tantivy_index.rs (renamed from tantivy.rs)
- **Verification:** `cargo check` passes with zero errors after rename
- **Committed in:** ef0d7f8 (Task 1 commit)

**2. [Rule 2 - Missing Critical] Inlined iso8601_utc in tantivy_index.rs**
- **Found during:** Task 1 (write_version implementation)
- **Issue:** `format_iso8601_utc` in vault.rs is `pub(crate)` — using it from tantivy_index.rs creates tight coupling between indexer and vault command layer.
- **Fix:** Copied the same Howard Hinnant algorithm as a private `iso8601_utc` function in tantivy_index.rs.
- **Files modified:** src-tauri/src/indexer/tantivy_index.rs
- **Verification:** `cargo check` passes, write_version tests pass
- **Committed in:** ef0d7f8 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 bug fix — name shadowing, 1 missing critical — module coupling)
**Impact on plan:** Both fixes necessary for compilation and correctness. No scope creep. Plan's exported interfaces (CURRENT_SCHEMA_VERSION, build_schema, open_or_create_index, check_version, write_version, extract_title, FileIndex, FileMeta, strip_markdown, IndexCoordinator, IndexCmd) all present as specified.

## Issues Encountered

- tantivy 0.26 requires rust-version 1.86 but Cargo.toml specifies `rust-version = "1.77.2"`. Installed rustc is 1.94.1 so there was no actual build failure — `rust-version` in Cargo.toml is the minimum the project advertises, not a hard cap. Left as-is; can be updated in a later cleanup plan.

## User Setup Required

None — no external service configuration required. The Tantivy index is created automatically on first vault open at `<vault>/.vaultcore/index/tantivy/`.

## Next Phase Readiness

- Plan 03-02 (search commands) can now import `IndexCoordinator` from `VaultState.index_coordinator`, clone `Arc<IndexReader>` and `Arc<Index>` for query execution
- Plan 03-03 (quick switcher) can import `Arc<Mutex<nucleo_matcher::Matcher>>` and `Arc<Mutex<FileIndex>>` from `IndexCoordinator`
- Schema version is 1 — any future schema change increments `CURRENT_SCHEMA_VERSION` in tantivy_index.rs to trigger automatic rebuild

---
*Phase: 03-search*
*Completed: 2026-04-12*
