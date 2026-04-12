---
phase: 03-search
verified: 2026-04-12T15:30:00Z
status: human_needed
score: 4/5 must-haves verified
overrides_applied: 0
gaps:
deferred:
  - truth: "The in-memory index (FileIndex, LinkGraph, TagIndex) is all rebuilt from disk on every cold start (IDX-04 full scope)"
    addressed_in: "Phase 4 (LinkGraph via LINK-08) and Phase 5 (TagIndex via TAG-01..04)"
    evidence: "Phase 4 SC 5: 'link graph stays accurate as notes are created, edited, and deleted'; REQUIREMENTS.md maps LINK-08 to Phase 4 and TAG-01..04 to Phase 5. Phase 3 delivers FileIndex only — this was the plan's stated scope."
human_verification:
  - test: "Open a vault with multiple .md files and verify full indexing flow"
    expected: "Progress bar shows filename and N / TOTAL counter during initial index; search panel finds notes by content"
    why_human: "Requires running pnpm tauri dev with a real vault; cannot verify progress event rendering programmatically"
  - test: "Cmd/Ctrl+Shift+F opens search tab with focused input, type query, verify ranked results with snippets"
    expected: "Sidebar switches to Suche tab, input focused, results appear after ~200ms with filename + snippet + highlighted terms, counter reads 'N Treffer in M Dateien'"
    why_human: "Live UI behavior with debounce timing, snippet rendering, and result display requires human observation"
  - test: "Click a search result and verify scroll-to-match with flash highlight"
    expected: "File opens in tab, editor scrolls to first match, yellow highlight appears and fades over ~2.5 seconds"
    why_human: "CM6 decoration rendering, scroll behavior, and CSS fade transition require visual verification"
  - test: "Cmd/Ctrl+P opens Quick Switcher; empty input shows recently opened files; typing shows fuzzy matches with highlighted characters; ArrowUp/Down/Enter/Escape navigation works"
    expected: "Modal centered in upper third with 'Zuletzt geoffnet' section on empty input, per-character bold+accent highlights on results, keyboard nav selects and opens file"
    why_human: "Modal rendering, keyboard navigation, and per-character highlight require interactive testing"
  - test: "Close and reopen vault to verify warm-start incremental indexing"
    expected: "Second open is noticeably faster; only changed files are re-indexed (SHA-256 skip for unchanged)"
    why_human: "Requires timing comparison between cold start and warm start with a populated vault"
  - test: "Click 'Index neu aufbauen' button in search panel"
    expected: "Spinning icon appears, toast 'Index wird neu aufgebaut...' shown, rebuild completes in background, search input disabled during rebuild"
    why_human: "Requires visual inspection of spinner, toast, and disabled state during async rebuild"
  - test: "Corrupt or delete .vaultcore/index/tantivy/ manually, then open vault"
    expected: "App handles the corrupt index gracefully — either auto-rebuilds or shows a meaningful error (ERR-02 partial coverage)"
    why_human: "ERR-02 auto-rebuild for non-schema corrupt cases is not fully implemented (see note below); need to verify user experience"
---

# Phase 3: Search Verification Report

**Phase Goal:** User can find any note in the vault within tens of milliseconds via either a Tantivy full-text search panel or a fuzzy filename Quick Switcher, backed by an incremental hash-driven indexer.
**Verified:** 2026-04-12T15:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | Opening vault indexes every .md file into Tantivy and in-memory store, with live progress bar; non-UTF-8 files skipped silently | ✓ VERIFIED | `index_vault` in `indexer/mod.rs:181-256` walks all .md files, emits `vault://index_progress` at 50ms throttle; non-UTF-8 silently skipped via `read_to_string` match; Cargo.toml has tantivy=0.26 |
| SC2 | Cmd/Ctrl+Shift+F opens search panel; AND/OR/NOT/"phrase" query support; ranked results with snippets; click opens note at match | ✓ VERIFIED | `VaultLayout.svelte:139` wires Cmd+Shift+F to `searchStore.setActiveTab("search")`; `search.rs` uses `parse_query_lenient` + `SnippetGenerator`; `SearchPanel.svelte:57-64` calls `scrollStore.requestScrollToMatch`; `EditorPane.svelte:79-97` executes scroll via `scrollToMatch()` |
| SC3 | Cmd/Ctrl+P Quick Switcher responds to every keystroke without perceptible lag | ✓ VERIFIED | `VaultLayout.svelte:143-145` wires Cmd+P; `QuickSwitcher.svelte:69` calls `searchFilename` with no debounce; nucleo Pattern::parse in `search.rs:195` with pre-warmed Matcher; no artificial delays |
| SC4 | Warm re-open uses cached index, only re-parses changed SHA-256 files; schema bump triggers delete-and-rebuild; manual rebuild_index available | ✓ VERIFIED | `mod.rs:192-196` checks hash and skips unchanged; `mod.rs:159-172` deletes index_dir on version mismatch; `search.rs:245` implements `rebuild_index` command; `commands.ts:200` IPC wrapper |
| SC5 | Index writes serialized through single queue; IndexCorrupt detection kicks off automatic rebuild without user intervention | PARTIAL | Single mpsc queue verified (`mod.rs:109`, capacity=1024, single IndexWriter). Schema-error and OpenDirectoryError auto-create a fresh index. However: `open_or_create_index` line 46 returns `VaultError::IndexCorrupt` for other Tantivy errors, which propagates to the user as an error — no automatic rebuild with progress UI for non-schema corruption cases. |

**Score:** 4/5 truths fully verified (SC5 partial)

### Deferred Items

Items not yet met but explicitly addressed in later milestone phases.

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | LinkGraph rebuilt from disk on cold start (IDX-04 partial) | Phase 4 | LINK-08: "The link graph is built from disk on startup"; Phase 4 SC 5: "link graph stays accurate" |
| 2 | TagIndex rebuilt from disk on cold start (IDX-04 partial) | Phase 5 | TAG-01..04 in Phase 5 — Polish |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/indexer/mod.rs` | IndexCoordinator, IndexCmd, index_vault, queue consumer | ✓ VERIFIED | All exports confirmed; mpsc queue capacity=1024; single IndexWriter in background tokio task |
| `src-tauri/src/indexer/tantivy_index.rs` | build_schema, open_or_create_index, check_version, write_version, extract_title, CURRENT_SCHEMA_VERSION=1 | ✓ VERIFIED | All 6 exports confirmed; named tantivy_index (not tantivy) to avoid shadowing |
| `src-tauri/src/indexer/memory.rs` | FileIndex, FileMeta | ✓ VERIFIED | FileIndex with HashMap<PathBuf, FileMeta>; all CRUD methods including all_relative_paths |
| `src-tauri/src/indexer/parser.rs` | strip_markdown | ✓ VERIFIED | pulldown-cmark based implementation |
| `src-tauri/src/commands/search.rs` | search_fulltext, search_filename, rebuild_index, SearchResult, FileMatch | ✓ VERIFIED | QueryParser, parse_query_lenient, SnippetGenerator at 200 chars, nucleo Pattern::parse, TopDocs with order_by_score |
| `src/types/search.ts` | SearchResult, FileMatch interfaces | ✓ VERIFIED | Both interfaces with camelCase-aligned fields including matchIndices |
| `src/ipc/commands.ts` | searchFulltext, searchFilename, rebuildIndex wrappers | ✓ VERIFIED | All three wrappers with normalizeError pattern; correct invoke names |
| `src/store/searchStore.ts` | query, results, isSearching, isRebuilding, activeTab state | ✓ VERIFIED | All fields and methods present; createSearchStore pattern |
| `src/components/Sidebar/Sidebar.svelte` | Tabbed sidebar Dateien/Suche | ✓ VERIFIED | vc-sidebar-tabs, role="tablist", aria-selected, searchStore.activeTab conditional rendering |
| `src/components/Search/SearchPanel.svelte` | Search panel with rebuild button | ✓ VERIFIED | searchFulltext, rebuildIndex, RefreshCw, Indexierung overlay, scrollStore wiring |
| `src/components/Search/SearchInput.svelte` | Debounced input with ARIA | ✓ VERIFIED | role="searchbox", aria-label="Volltextsuche", 200ms setTimeout debounce, Suche löschen clear button |
| `src/components/Search/SearchResults.svelte` | Counter, listbox, overflow hint | ✓ VERIFIED | Treffer in Dateien counter, role="listbox", Suche verfeinern overflow hint, Keine Treffer empty state |
| `src/components/Search/SearchResultRow.svelte` | Filename + HTML snippet | ✓ VERIFIED | {@html result.snippet} with vc-search-snippet class |
| `src/components/Search/QuickSwitcher.svelte` | Modal with keyboard nav, recents, fuzzy search | ✓ VERIFIED | role="dialog", aria-modal, Schnellwechsler label, tabStore recents, ArrowUp/Down/Enter/Escape, searchFilename |
| `src/components/Search/QuickSwitcherRow.svelte` | Per-char match highlighting | ✓ VERIFIED | matchIndices with font-weight:700 and var(--color-accent) |
| `src/components/Editor/flashHighlight.ts` | flashEffect, flashField, scrollToMatch | ✓ VERIFIED | StateEffect.define, StateField.define, vc-flash-highlight decoration, rAF fade, 2600ms cleanup |
| `src/store/scrollStore.ts` | One-shot scroll request coordinator | ✓ VERIFIED | requestScrollToMatch, clearPending, unique token per request |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `commands/vault.rs` | `indexer/mod.rs` | `coordinator.index_vault` | ✓ WIRED | `vault.rs:177` calls `coordinator.index_vault(&canonical, &app)` |
| `indexer/mod.rs` | `vault://index_progress` | `app.emit(PROGRESS_EVENT, ...)` | ✓ WIRED | `mod.rs:246` emits throttled progress events |
| `commands/search.rs` | `indexer/mod.rs` | `index_coordinator` access | ✓ WIRED | `search.rs:81` locks `state.index_coordinator` to get reader/index |
| `src/ipc/commands.ts` | `commands/search.rs` | `invoke('search_fulltext')` | ✓ WIRED | `commands.ts:173` invokes search_fulltext |
| `SearchPanel.svelte` | `searchStore` | subscribes for state | ✓ WIRED | searchStore imported and subscribed |
| `SearchInput.svelte` | `src/ipc/commands.ts` | `searchFulltext` on debounced input | ✓ WIRED | `SearchPanel.svelte:34` calls searchFulltext after 200ms debounce |
| `VaultLayout.svelte` | `Sidebar.svelte` | Cmd+Shift+F sets activeTab | ✓ WIRED | `VaultLayout.svelte:139` calls `searchStore.setActiveTab("search")` |
| `QuickSwitcher.svelte` | `src/ipc/commands.ts` | `searchFilename` | ✓ WIRED | `QuickSwitcher.svelte:69` calls `searchFilename(q, 20)` |
| `QuickSwitcher.svelte` | `tabStore` | reads recently opened files | ✓ WIRED | `QuickSwitcher.svelte:26` subscribes to tabStore |
| `EditorPane.svelte` | `flashHighlight.ts` | `flashField` in buildExtensions | ✓ WIRED | `extensions.ts:47` includes flashField; `EditorPane.svelte:13-14` imports scrollToMatch and scrollStore |
| `SearchPanel.svelte` | `scrollStore` | result click triggers requestScrollToMatch | ✓ WIRED | `SearchPanel.svelte:63` calls `scrollStore.requestScrollToMatch` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `SearchResults.svelte` | results: SearchResult[] | `searchStore.results` → `searchFulltext()` → Tantivy BM25 query | Yes — QueryParser + TopDocs against live index | ✓ FLOWING |
| `QuickSwitcher.svelte` | results: FileMatch[] | `searchFilename()` → nucleo Pattern::parse against FileIndex.all_relative_paths() | Yes — nucleo against live in-memory FileIndex | ✓ FLOWING |
| `SearchResultRow.svelte` | result.snippet | SearchResult from Tantivy SnippetGenerator | Yes — SnippetGenerator.create() generates HTML snippets from body field | ✓ FLOWING |
| `QuickSwitcherRow.svelte` | matchIndices: number[] | FileMatch from nucleo pattern.indices() | Yes — nucleo returns actual matched character positions | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Cargo compiles with all deps | `cargo check` from src-tauri | `Finished dev profile` with zero errors | ✓ PASS |
| All 83 unit tests pass | `cargo test` | `83 passed; 0 failed` | ✓ PASS |
| TypeScript compiles (search files) | `npx tsc --noEmit` | Zero new errors in search files (4 pre-existing tabStore errors out of scope, documented in 03-02-SUMMARY) | ✓ PASS |
| Full UI verification (15 steps) | `pnpm tauri dev` | Task 3 in Plan 04 was auto-approved without human running the 15 steps | ? SKIP (human needed) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| IDX-01 | Plan 01 | Opening vault indexes all .md files into Tantivy and in-memory index | ✓ SATISFIED | `index_vault` method in mod.rs: walks all .md files, sends AddFile to queue, commits |
| IDX-03 | Plan 01 | Incremental re-indexing via SHA-256 hash comparison | ✓ SATISFIED | `mod.rs:192-196`: checks `m.hash == hash` before re-indexing |
| IDX-04 | Plan 01 | In-memory index rebuilt from disk on every cold start (FileIndex portion) | ✓ SATISFIED (partial) | FileIndex always starts fresh via `FileIndex::new()` and is populated by `index_vault`. LinkGraph/TagIndex deferred to Phases 4/5. |
| IDX-05 | Plan 01 | index_version.json sidecar; schema mismatch triggers delete-and-rebuild | ✓ SATISFIED | `tantivy_index.rs:58-100` implements check_version/write_version; `mod.rs:159-172` deletes index on mismatch |
| IDX-06 | Plan 01 | All Tantivy writes through single central queue | ✓ SATISFIED | Single mpsc channel (capacity=1024) with one IndexWriter in background task; `mod.rs:109-120` |
| IDX-08 | Plan 01 | Non-UTF-8 files shown in browser but skipped by indexer | ✓ SATISFIED | `mod.rs:182-185`: `read_to_string` error → `continue` silently |
| IDX-09 | Plan 02 | Manual index rebuild via rebuild_index command | ✓ SATISFIED | `search.rs:245`: `rebuild_index` Tauri command; sends `IndexCmd::Rebuild` via mpsc tx |
| SRCH-01 | Plan 03 | Cmd/Ctrl+Shift+F opens full-text search panel | ✓ SATISFIED | `VaultLayout.svelte:134-141`: Shift+F handler sets activeTab to "search" |
| SRCH-02 | Plan 02 | Full-text results include filename, relevance rank, contextual snippet | ✓ SATISFIED | `SearchResult` struct has path, title, score, snippet, matchCount; SnippetGenerator at 200 chars |
| SRCH-03 | Plan 02 | Search supports AND, OR, NOT, phrase queries | ✓ SATISFIED | `parse_query_lenient` with QueryParser targeting title+body fields; placeholder text shows syntax hint |
| SRCH-04 | Plans 02, 04 | Cmd/Ctrl+P opens Quick Switcher with fuzzy filename matching | ✓ SATISFIED | `VaultLayout.svelte:143-145`; `search.rs:162` implements search_filename with nucleo |
| SRCH-05 | Plan 02 | Quick Switcher and full-text search backed by separate commands | ✓ SATISFIED | `search_filename` and `search_fulltext` are distinct Tauri commands registered in lib.rs:102-103 |
| SRCH-06 | Plans 03, 04 | Clicking search result opens note at match location | ✓ SATISFIED | `SearchPanel.svelte:57-64` calls `scrollStore.requestScrollToMatch`; `EditorPane.svelte:79-97` executes `scrollToMatch` with CM6 flash decoration |
| ERR-02 | Plan 01 | Index-corrupt detection triggers automatic rebuild with progress UI | PARTIAL | Schema-error and OpenDirectoryError auto-create fresh index (no progress UI). But `open_or_create_index:46`: other TantivyError → `VaultError::IndexCorrupt` returned to user without auto-rebuild or progress events. The schema-version mismatch path (IDX-05) provides auto-rebuild with toast notification but not progress bar. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None detected | — | No TODOs, FIXMEs, placeholder returns, or hardcoded empty data in search-related files | — | — |

### Human Verification Required

#### 1. Full Indexing Flow (SC1)

**Test:** Open a vault containing at least 10 .md files. Watch the progress bar during initial indexing.
**Expected:** Progress counter shows "N / TOTAL" with current filename; completes without error; opening the Suche tab and typing a word from a note returns results.
**Why human:** Progress event rendering in the UI and live search results require running the full app.

#### 2. Search Panel End-to-End (SC2)

**Test:** Press Cmd/Ctrl+Shift+F; type a query using AND, OR, or a "quoted phrase"; click a result.
**Expected:** Sidebar switches to Suche tab with focused input; results appear after ~200ms with filename + snippet with highlighted terms; result counter shows "N Treffer in M Dateien"; clicking a result opens the file and scrolls to the match with a yellow flash that fades over ~2.5 seconds.
**Why human:** Debounce timing, snippet HTML rendering with highlight, scroll behavior, and CSS fade transition all require interactive visual testing.

#### 3. Quick Switcher (SC3)

**Test:** Press Cmd/Ctrl+P; check empty state; type a partial filename; use ArrowUp/Down + Enter + Escape.
**Expected:** Modal appears centered; "Zuletzt geöffnet" section lists recently opened tabs; fuzzy results show with per-character bold+accent highlights; keyboard nav selects correct item; Enter opens the file; Escape closes modal.
**Why human:** Modal layout, per-character rendering, and keyboard focus trap require visual and interactive testing.

#### 4. Warm Start Incremental Indexing (SC4)

**Test:** Close and reopen the same vault immediately after first index.
**Expected:** Second open completes visibly faster (hash comparison skips unchanged files); modified files are re-indexed.
**Why human:** Requires timing comparison and vault with known modified files.

#### 5. Manual Rebuild (SC4 / IDX-09)

**Test:** Click "Index neu aufbauen" button in search panel header.
**Expected:** Spinning RefreshCw icon while rebuild in progress; toast "Index wird neu aufgebaut..."; search input disabled; rebuild completes; search remains functional.
**Why human:** Spinner animation, toast display, and disabled input state require visual inspection.

#### 6. ERR-02 Corrupt Index Behavior (SC5 partial gap)

**Test:** With a vault open and indexed, manually corrupt .vaultcore/index/tantivy/ (e.g., delete a segment file), then close and reopen the vault.
**Expected per spec:** Automatic rebuild with progress UI. **Note:** Current implementation returns `VaultError::IndexCorrupt` to the frontend for non-schema corruption (returns error, not auto-rebuild). The SchemaError path does fall through to auto-create but without a progress bar. Verify the actual user experience — a clear error toast is acceptable if it explains how to rebuild (manual rebuild button is available).
**Why human:** Requires deliberate index corruption and observation of actual error handling behavior.

### Gaps Summary

No blocking gaps were found. The codebase delivers the core phase goal: Tantivy full-text search, nucleo Quick Switcher, incremental hash-driven indexing, schema-version auto-rebuild, and all UI components wired end-to-end.

**Noted partial implementation (SC5 / ERR-02):** The IndexCorrupt auto-rebuild path covers the common schema-mismatch case (IDX-05) but does not cover all corrupt-index scenarios. Specifically, when `open_or_create_index` encounters a non-schema Tantivy error (e.g., corrupted segment files), it returns `VaultError::IndexCorrupt` as an error rather than initiating an automatic rebuild with progress events. The manual `rebuild_index` command (IDX-09) and the schema-version wipe-and-rebuild (IDX-05) together provide strong coverage; the remaining gap is an edge case (physical index corruption) that could be addressed by having `open_vault` retry with a delete-and-recreate on `IndexCorrupt` from `IndexCoordinator::new()`.

**Plan 04 Task 3 (human verify checkpoint) was auto-approved** without actually running the 15-step manual verification checklist. This is the primary reason for `human_needed` status — all automated checks pass but the full interactive experience has not been verified by a human.

---

_Verified: 2026-04-12T15:30:00Z_
_Verifier: Claude (gsd-verifier)_
