---
phase: 03-search
plan: "02"
subsystem: search
tags: [tantivy, nucleo-matcher, rust, typescript, svelte, ipc, search-commands, snippet-generator]

requires:
  - phase: 03-search
    plan: "01"
    provides: IndexCoordinator, Arc<Index>, Arc<IndexReader>, Arc<Mutex<FileIndex>>, Arc<Mutex<Matcher>>, mpsc::Sender<IndexCmd>

provides:
  - search_fulltext Tauri command: Tantivy BM25 ranked search with parse_query_lenient, SnippetGenerator (200-char HTML snippets)
  - search_filename Tauri command: nucleo Pattern::parse fuzzy matching with match_indices for highlight
  - rebuild_index Tauri command: enqueues IndexCmd::Rebuild via cloned mpsc Sender
  - src/types/search.ts: SearchResult and FileMatch TypeScript interfaces (camelCase-aligned with serde)
  - src/ipc/commands.ts: searchFulltext, searchFilename, rebuildIndex IPC wrappers
  - src/store/searchStore.ts: writable Svelte store with full search state

affects:
  - 03-03-quick-switcher (shares FileIndex and nucleo Matcher via IndexCoordinator)
  - 03-04-search-ui (imports searchStore, calls searchFulltext/searchFilename)

tech-stack:
  added: []
  patterns:
    - Clone Arc<Index> + Arc<IndexReader> before releasing Mutex — avoids holding MutexGuard across async boundary
    - TopDocs::with_limit(n).order_by_score() — required to satisfy Collector trait bound in tantivy 0.26
    - use tantivy::schema::document::Value — trait must be in scope for as_str() on CompactDocValue
    - Clone mpsc::Sender before await in rebuild_index — MutexGuard is not Send, cannot be held across await
    - nucleo Pattern::parse (not Atom::parse) — multi-word query with $, !, ^ syntax parsing
    - indices sorted + deduped per nucleo docs — multiple atoms append independently

key-files:
  created:
    - src-tauri/src/commands/search.rs (SearchResult, FileMatch, search_fulltext, search_filename, rebuild_index)
    - src/types/search.ts (SearchResult, FileMatch interfaces)
    - src/store/searchStore.ts (createSearchStore, searchStore export)
  modified:
    - src-tauri/src/commands/mod.rs (added pub mod search)
    - src-tauri/src/lib.rs (registered 3 commands in invoke_handler)
    - src-tauri/src/indexer/mod.rs (made tx field pub on IndexCoordinator)

key-decisions:
  - "TopDocs::with_limit(n).order_by_score() required — bare TopDocs does not implement Collector in tantivy 0.26 without a sort key"
  - "Clone Arc handles before releasing Mutex to avoid holding MutexGuard across .await — Mutex guard is not Send"
  - "Clone mpsc::Sender before await in rebuild_index — same Send constraint; avoids architectural change to tokio::sync::Mutex"
  - "IndexCoordinator.tx made pub — rebuild_index needs to clone the sender; alternatives (method wrapper or tokio Mutex) would be more invasive"

metrics:
  duration: 6min
  completed: 2026-04-12
  tasks: 2
  files: 6
---

# Phase 3 Plan 02: Search Commands Summary

**Three Rust search commands (search_fulltext, search_filename, rebuild_index) bridging Tantivy/nucleo backend to frontend via typed IPC wrappers and a Svelte searchStore**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-04-12T14:31:48Z
- **Completed:** 2026-04-12T14:37:25Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Created `src-tauri/src/commands/search.rs` with three production-ready Tauri commands:
  - `search_fulltext`: Tantivy QueryParser with `parse_query_lenient` (never throws on bad syntax), `SnippetGenerator` at 200 chars, `TopDocs::with_limit(n).order_by_score()` for ranked results
  - `search_filename`: nucleo `Pattern::parse` with `CaseMatching::Ignore` + `Normalization::Smart`, returns `match_indices` for frontend highlight, Matcher pre-warmed from IndexCoordinator
  - `rebuild_index`: clones `mpsc::Sender` before the `.await` to satisfy the `Send` bound, emits toast events for start/background-progress
- Registered all three commands in `tauri::generate_handler!` in `lib.rs`
- Created `src/types/search.ts` with `SearchResult` and `FileMatch` interfaces matching serde camelCase output
- Extended `src/ipc/commands.ts` with `searchFulltext`, `searchFilename`, `rebuildIndex` wrappers following the existing `normalizeError` pattern
- Created `src/store/searchStore.ts` — classic `writable` store (D-06/RC-01) with `query`, `results`, `totalMatches`, `totalFiles`, `isSearching`, `isRebuilding`, `activeTab` state and action methods
- `cargo check` passes with zero errors; TypeScript compiles cleanly for all new files

## Task Commits

1. **Task 1: Rust search commands** — `8db2fe6` (feat)
2. **Task 2: Frontend types, IPC wrappers, searchStore** — `2eda67c` (feat)

## Files Created/Modified

- `/home/sokragent/Projects/vaultcore/src-tauri/src/commands/search.rs` — SearchResult, FileMatch, search_fulltext, search_filename, rebuild_index
- `/home/sokragent/Projects/vaultcore/src-tauri/src/commands/mod.rs` — added `pub mod search`
- `/home/sokragent/Projects/vaultcore/src-tauri/src/lib.rs` — registered 3 commands in invoke_handler
- `/home/sokragent/Projects/vaultcore/src-tauri/src/indexer/mod.rs` — made `tx` field `pub` on IndexCoordinator
- `/home/sokragent/Projects/vaultcore/src/types/search.ts` — SearchResult and FileMatch TypeScript interfaces
- `/home/sokragent/Projects/vaultcore/src/ipc/commands.ts` — searchFulltext, searchFilename, rebuildIndex IPC wrappers
- `/home/sokragent/Projects/vaultcore/src/store/searchStore.ts` — searchStore with full search state management

## Decisions Made

- **TopDocs needs `.order_by_score()`:** In tantivy 0.26, bare `TopDocs` does not implement `Collector` without a sort key — `TopDocs::with_limit(n).order_by_score()` returns an `impl Collector<Fruit = Vec<(Score, DocAddress)>>`.
- **Clone Arcs before releasing Mutex:** `search_fulltext` extracts `Arc<Index>` and `Arc<IndexReader>` from the coordinator while holding the lock, then releases the lock before performing any search. This avoids holding a non-`Send` `MutexGuard` across `.await` points.
- **Clone mpsc::Sender in rebuild_index:** Same `Send` constraint applies. Cloning `Sender` is cheap and idiomatic — the clone shares the same channel.
- **IndexCoordinator.tx made pub:** `rebuild_index` needs to clone the sender to dispatch `IndexCmd::Rebuild`. Making `tx` pub is the minimal invasive change; wrapping in a method would add equivalent exposure.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TopDocs::with_limit() alone does not implement Collector in tantivy 0.26**
- **Found during:** Task 1 (first cargo check)
- **Issue:** Plan spec said `TopDocs::with_limit(limit)` as the collector, but this does not satisfy the `Collector` trait bound — tantivy 0.26 requires a sort key via `.order_by_score()` or `.order_by_fast_field()`.
- **Fix:** Changed to `TopDocs::with_limit(limit).order_by_score()` which returns `impl Collector<Fruit = Vec<(Score, DocAddress)>>`.
- **Files modified:** src-tauri/src/commands/search.rs
- **Commit:** 8db2fe6

**2. [Rule 1 - Bug] as_str() not in scope for CompactDocValue**
- **Found during:** Task 1 (first cargo check)
- **Issue:** `v.as_str()` on `CompactDocValue` requires the `tantivy::schema::document::Value` trait to be in scope — it is a trait method, not an inherent method.
- **Fix:** Added `use tantivy::schema::document::Value;` import.
- **Files modified:** src-tauri/src/commands/search.rs
- **Commit:** 8db2fe6

**3. [Rule 1 - Bug] MutexGuard held across await in search_filename and rebuild_index**
- **Found during:** Task 1 (first cargo check, `future cannot be sent between threads safely`)
- **Issue:** Holding `std::sync::MutexGuard` across `.await` makes the future `!Send`, which is rejected by `tauri::generate_handler!`.
- **Fix:** In `search_filename`: extract `Arc` clones (via `file_index()` and `matcher()` methods) before releasing the coordinator lock. In `rebuild_index`: clone the `mpsc::Sender` before releasing the coordinator lock, then `await` the send without holding any lock.
- **Files modified:** src-tauri/src/commands/search.rs
- **Commit:** 8db2fe6

---

**Total deviations:** 3 auto-fixed (all Rule 1 — compilation bugs from API differences between plan spec and tantivy 0.26 runtime)

## Known Stubs

None — all commands wire to live Tantivy/nucleo data. Search results will be empty until a vault is open and indexed (normal behavior).

## Threat Flags

No new threat surface beyond what was declared in the plan's threat_model (T-03-06, T-03-07, T-03-08 — all mitigated in implementation).

## Issues Encountered

- Pre-existing TypeScript errors in `src/store/tabStore.ts` (string | undefined vs string | null) discovered during Task 2 tsc run — logged to `deferred-items.md`, out of scope for this plan.

## Next Phase Readiness

- Plan 03-03 (quick switcher) can import `searchFilename` from `src/ipc/commands.ts` and subscribe to `searchStore`
- Plan 03-04 (search UI) can import `searchStore`, `searchFulltext`, `rebuildIndex` to build the full search sidebar
- All three Tauri commands are registered and callable from any Svelte component

---
*Phase: 03-search*
*Completed: 2026-04-12*
