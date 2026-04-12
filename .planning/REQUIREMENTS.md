# Requirements: VaultCore

**Defined:** 2026-04-11
**Core Value:** Stay fluid at 100,000+ notes — open, search, link, and edit a vault of that size without perceptible lag.

## v1 Requirements

Requirements for MVP v0.1. Each maps to a roadmap phase. Sourced from `VaultCore_MVP_Spezifikation_v3.md`.

### Vault

- [x] **VAULT-01**: User can open a vault folder via a native OS folder picker
- [x] **VAULT-02**: Recent-vaults list is persisted as JSON in the Tauri app-data directory
- [x] **VAULT-03**: On startup, the last opened vault is loaded automatically if still reachable
- [x] **VAULT-04**: When no vault is open, a Welcome screen is shown with an "Open vault" button and the recent list
- [x] **VAULT-05**: If the last vault is no longer reachable, the app falls back to the Welcome screen without crashing
- [x] **VAULT-06**: A `VaultInfo` / `VaultStats` command surfaces vault path and note count

### Indexing

- [x] **IDX-01**: Opening a vault indexes all `.md` files into Tantivy and into the in-memory metadata index
- [x] **IDX-02**: A progress bar with filename and counter ("12,483 / 100,000") is shown during indexing, fed by Tauri events
- [x] **IDX-03**: Incremental re-indexing uses SHA-256 hash comparison; only changed files are re-parsed
- [x] **IDX-04**: The in-memory index (FileIndex, LinkGraph, TagIndex) is rebuilt from disk on every cold start
- [x] **IDX-05**: Tantivy index stores an `index_version.json` sidecar; on schema mismatch the index is deleted and rebuilt with progress UI
- [x] **IDX-06**: All Tantivy writes go through a single central queue (never two concurrent writes for the same file)
- [x] **IDX-07**: The `.obsidian/` folder is ignored by both the file browser and the indexer
- [x] **IDX-08**: Non-UTF-8 files are shown in the browser but skipped by the indexer
- [x] **IDX-09**: User can trigger a manual index rebuild via `rebuild_index` command

### Editor

- [x] **EDIT-01**: CodeMirror 6 renders Markdown with syntax highlighting (headings, bold, italic, code, lists, tables GFM)
- [x] **EDIT-02**: Inline live-preview of bold, italic, headings, inline code, and lists
- [x] **EDIT-03**: Fenced code blocks render with per-language syntax highlighting
- [x] **EDIT-04**: Keyboard shortcuts work: Cmd/Ctrl+B (bold), Cmd/Ctrl+I (italic), Cmd/Ctrl+K (link)
- [x] **EDIT-05**: Multi-tab: user can open multiple notes simultaneously and switch with Cmd/Ctrl+Tab
- [x] **EDIT-06**: Split-view: two notes can be displayed and edited side-by-side
- [x] **EDIT-07**: Undo/redo work within each tab (provided by CM6)
- [x] **EDIT-08**: There is no file-size limit — a 10,000-line note opens without degradation
- [x] **EDIT-09**: Auto-save writes the active note to disk every 2 seconds (no manual save, no dirty indicator)
- [ ] **EDIT-10**: Before each auto-save, the on-disk hash is compared to the expected hash; mismatch triggers the merge path
- [x] **EDIT-11**: New note creation via Cmd/Ctrl+N

### Search

- [x] **SRCH-01**: Cmd/Ctrl+Shift+F opens the full-text search panel
- [x] **SRCH-02**: Full-text search results include filename, relevance rank, and a contextual snippet
- [x] **SRCH-03**: Search supports AND, OR, NOT, and phrase queries (`"exact text"`)
- [x] **SRCH-04**: Cmd/Ctrl+P opens the Quick Switcher with fuzzy filename matching
- [x] **SRCH-05**: Quick Switcher and full-text search are backed by separate commands (`search_filename`, `search_fulltext`)
- [x] **SRCH-06**: Clicking a search result opens the note at the match location

### Links

- [x] **LINK-01**: `[[Note]]` and `[[Note|alias]]` are parsed and rendered as clickable wiki-links
- [x] **LINK-02**: Link resolution uses 3-stage shortest-path: (1) exact match in the same folder, (2) shortest relative path, (3) alphabetical tiebreak
- [x] **LINK-03**: Clicking a resolved wiki-link opens the target note in a new tab
- [x] **LINK-04**: Unresolved wiki-links are visually distinct (different color) in the editor
- [x] **LINK-05**: Typing `[[` opens an autocomplete list of matching filenames
- [x] **LINK-06**: Backlinks panel shows every note whose parsed links point to the currently-active note
- [x] **LINK-07**: `get_unresolved_links` command returns all dangling links in the vault
- [x] **LINK-08**: The link graph is built from disk on startup (adjacency list) and updated incrementally on file changes
- [x] **LINK-09**: Renaming a file updates every wiki-link pointing at it after a confirmation dialog ("X links will be updated. Continue?")

### Files

- [x] **FILE-01**: The sidebar shows a folder/file tree for the open vault with lazy loading of subtrees
- [x] **FILE-02**: User can create a new file from the file browser
- [x] **FILE-03**: User can rename files (triggers the LINK-09 cascade when links are affected)
- [x] **FILE-04**: Deleting a file moves it to `<vault>/.trash/` rather than permanently removing it
- [x] **FILE-05**: User can move files by drag-and-drop
- [x] **FILE-06**: Sorting options: name, modified date, created date; order is remembered
- [ ] **FILE-07**: Folder expand/collapse state is persisted across sessions
- [x] **FILE-08**: Symbolic links are displayed but not followed
- [x] **FILE-09**: Non-UTF-8 files are displayed; attempting to open one shows a toast error and does not load them into the editor

### Tags

- [x] **TAG-01**: Inline tags (`#tag` and nested `#parent/child`) are extracted from note bodies
- [x] **TAG-02**: YAML frontmatter tags (`tags: [a, b]`) are extracted (YAML only, no TOML)
- [x] **TAG-03**: A tag panel in the sidebar lists all tags in the vault with usage counts
- [ ] **TAG-04**: Clicking a tag in the panel runs a search for all notes carrying it

### Sync / Concurrency

- [x] **SYNC-01**: File watcher (notify crate) detects external changes to vault files
- [x] **SYNC-02**: Write-ignore-list suppresses watcher events caused by backend writes (auto-save, rename, delete, move) with a 100 ms debounce window
- [x] **SYNC-03**: Bulk external changes are debounced over a 200 ms window and processed as a batch
- [x] **SYNC-04**: Batch parsing is parallelized with rayon; the full batch produces a single Tantivy commit
- [x] **SYNC-05**: Batches of > 500 files trigger the progress UI
- [x] **SYNC-06**: A three-way merge is used when an open file is modified externally; conflict detection is based on CM6 `docChanged`, not cursor position
- [x] **SYNC-07**: On true conflict at the same location, the local editor state wins
- [x] **SYNC-08**: Clean merges surface a toast "Externe Änderungen wurden eingebunden"; lossy conflicts surface "Konflikt in <file> – lokale Version behalten"

### UI / UX

- [x] **UI-01**: Dark mode and Light mode are implemented and can be toggled at runtime
- [x] **UI-02**: Font family and font size are configurable
- [x] **UI-03**: Sidebar can be collapsed/expanded with Cmd/Ctrl+\
- [x] **UI-04**: Toast component supports error, clean-merge, and conflict variants, auto-dismisses after 5 s, and is manually dismissable
- [x] **UI-05**: All MVP keyboard shortcuts from spec Section 13 are wired up
- [ ] **UI-06**: All user-facing surfaces (errors, merge notices, rename prompt) use the unified toast / dialog components

### Errors

- [x] **ERR-01**: `VaultError` enum exists in Rust with all variants from spec Section 5 (FileNotFound, PermissionDenied, DiskFull, IndexCorrupt, VaultUnavailable, MergeConflict, InvalidEncoding, Io)
- [x] **ERR-02**: Index-corrupt detection triggers an automatic rebuild with progress UI
- [x] **ERR-03**: If the vault folder becomes unreachable, the app stays open but disables editing and shows a toast
- [x] **ERR-04**: Disk-full failures during auto-save surface a toast but do not lose editor content
- [ ] **ERR-05**: Crash recovery loses at most 2 s of unsaved content (matches auto-save cadence)

### Performance

Benchmarks target a generated test vault of 100,000 Markdown files averaging ~500 words each.

- [ ] **PERF-01**: Cold start (no prior index) < 3 s
- [ ] **PERF-02**: Warm start (index present) < 5 s
- [ ] **PERF-03**: Opening a note < 100 ms
- [ ] **PERF-04**: Keystroke latency < 16 ms (60 fps)
- [ ] **PERF-05**: Full-text search < 50 ms
- [ ] **PERF-06**: Quick Switcher (filename) < 10 ms
- [ ] **PERF-07**: Backlinks computation < 20 ms
- [ ] **PERF-08**: Link autocomplete < 10 ms
- [ ] **PERF-09**: Initial vault indexing < 60 s
- [ ] **PERF-10**: Incremental single-file update < 5 ms
- [ ] **PERF-11**: RAM idle < 100 MB
- [ ] **PERF-12**: RAM active < 250 MB
- [ ] **PERF-13**: No crash over 24 h of continuous use with an open vault

### Platform / Release

- [ ] **REL-01**: Alpha builds produced for macOS (Intel + Apple Silicon), Windows 10/11, and Linux (Ubuntu 22.04+, Fedora 38+)
- [ ] **REL-02**: All unit tests (parser, indexer, link graph, merge engine, write-ignore-list) pass in CI
- [ ] **REL-03**: Integration test runs against the generated 100k-note vault in CI as a benchmark gate
- [ ] **REL-04**: Frontend component tests cover editor, sidebar, welcome screen

### Non-functional (Security / Privacy)

- [ ] **SEC-01**: No network calls from the Rust backend or frontend (verified by audit)
- [ ] **SEC-02**: No telemetry, analytics, or usage tracking code present
- [ ] **SEC-03**: All vault data stays on the local filesystem

## v2 Requirements

Acknowledged and architecture-prepared but not in the v0.1 roadmap.

### Plugins

- **PLUG-01**: Plugin API for extending editor, commands, and sidebar
- **PLUG-02**: Plugin marketplace / installation flow

### Visualization

- **GRAPH-01**: Interactive graph view of the link graph

### Attachments

- **ATT-01**: Image embeds via `![[image.png]]`
- **ATT-02**: Attachment copy/paste and drag-drop into notes
- **ATT-03**: Attachment indexing and deduplication

### Mobile

- **MOB-01**: iOS app sharing the Rust core
- **MOB-02**: Android app sharing the Rust core

## Out of Scope

| Feature | Reason |
|---------|--------|
| First-party cloud sync | Files stay local; third parties (Syncthing, iCloud) cover the need |
| WYSIWYG editor | Markdown-first with live-preview is the product choice |
| TOML frontmatter | YAML only, for Obsidian compatibility |
| Command palette | Quick Switcher covers the MVP use case |
| Manual save / dirty indicator | Auto-save every 2 s handles it |
| Following symbolic links | Cycle detection complexity too high for MVP |
| File size limit | CM6 handles large files natively; no need |
| License file / headers | Intentionally deferred in MVP |
| SQLite or any DB as primary store | Files are the source of truth; indexes are rebuildable cache |
| Telemetry / analytics | Non-negotiable privacy stance |
| Severity-tiered error UI | Unified toast is sufficient for MVP |

## Traceability

Populated by the roadmapper 2026-04-11 against ROADMAP.md.

| Requirement | Phase | Status |
|-------------|-------|--------|
| VAULT-01 | Phase 1 — Skeleton | Complete |
| VAULT-02 | Phase 1 — Skeleton | Complete |
| VAULT-03 | Phase 1 — Skeleton | Complete |
| VAULT-04 | Phase 1 — Skeleton | Complete |
| VAULT-05 | Phase 1 — Skeleton | Complete |
| VAULT-06 | Phase 1 — Skeleton | Complete |
| IDX-01 | Phase 3 — Search | Complete |
| IDX-02 | Phase 1 — Skeleton | Complete |
| IDX-03 | Phase 3 — Search | Complete |
| IDX-04 | Phase 3 — Search | Complete |
| IDX-05 | Phase 3 — Search | Complete |
| IDX-06 | Phase 3 — Search | Complete |
| IDX-07 | Phase 2 — Vault | Complete |
| IDX-08 | Phase 3 — Search | Complete |
| IDX-09 | Phase 3 — Search | Complete |
| EDIT-01 | Phase 1 — Skeleton | Complete |
| EDIT-02 | Phase 1 — Skeleton | Complete |
| EDIT-03 | Phase 5 — Polish | Complete |
| EDIT-04 | Phase 1 — Skeleton | Complete |
| EDIT-05 | Phase 2 — Vault | Complete |
| EDIT-06 | Phase 2 — Vault | Complete |
| EDIT-07 | Phase 5 — Polish | Complete |
| EDIT-08 | Phase 5 — Polish | Complete |
| EDIT-09 | Phase 1 — Skeleton | Complete |
| EDIT-10 | Phase 5 — Polish | Pending |
| EDIT-11 | Phase 5 — Polish | Complete |
| SRCH-01 | Phase 3 — Search | Complete |
| SRCH-02 | Phase 3 — Search | Complete |
| SRCH-03 | Phase 3 — Search | Complete |
| SRCH-04 | Phase 3 — Search | Complete |
| SRCH-05 | Phase 3 — Search | Complete |
| SRCH-06 | Phase 3 — Search | Complete |
| LINK-01 | Phase 4 — Links | Complete |
| LINK-02 | Phase 4 — Links | Complete |
| LINK-03 | Phase 4 — Links | Complete |
| LINK-04 | Phase 4 — Links | Complete |
| LINK-05 | Phase 4 — Links | Complete |
| LINK-06 | Phase 4 — Links | Complete |
| LINK-07 | Phase 4 — Links | Complete |
| LINK-08 | Phase 4 — Links | Complete |
| LINK-09 | Phase 4 — Links | Complete |
| FILE-01 | Phase 2 — Vault | Complete |
| FILE-02 | Phase 2 — Vault | Complete |
| FILE-03 | Phase 2 — Vault | Complete |
| FILE-04 | Phase 2 — Vault | Complete |
| FILE-05 | Phase 2 — Vault | Complete |
| FILE-06 | Phase 5 — Polish | Complete |
| FILE-07 | Phase 5 — Polish | Pending |
| FILE-08 | Phase 2 — Vault | Complete |
| FILE-09 | Phase 2 — Vault | Complete |
| TAG-01 | Phase 5 — Polish | Complete |
| TAG-02 | Phase 5 — Polish | Complete |
| TAG-03 | Phase 5 — Polish | Complete |
| TAG-04 | Phase 5 — Polish | Pending |
| SYNC-01 | Phase 2 — Vault | Complete |
| SYNC-02 | Phase 2 — Vault | Complete |
| SYNC-03 | Phase 2 — Vault | Complete |
| SYNC-04 | Phase 2 — Vault | Complete |
| SYNC-05 | Phase 2 — Vault | Complete |
| SYNC-06 | Phase 2 — Vault | Complete |
| SYNC-07 | Phase 2 — Vault | Complete |
| SYNC-08 | Phase 2 — Vault | Complete |
| UI-01 | Phase 5 — Polish | Complete |
| UI-02 | Phase 5 — Polish | Complete |
| UI-03 | Phase 5 — Polish | Complete |
| UI-04 | Phase 1 — Skeleton | Complete |
| UI-05 | Phase 5 — Polish | Complete |
| UI-06 | Phase 5 — Polish | Pending |
| ERR-01 | Phase 1 — Skeleton | Complete |
| ERR-02 | Phase 3 — Search | Complete |
| ERR-03 | Phase 2 — Vault | Complete |
| ERR-04 | Phase 2 — Vault | Complete |
| ERR-05 | Phase 6 — Benchmark & Release | Pending |
| PERF-01 | Phase 6 — Benchmark & Release | Pending |
| PERF-02 | Phase 6 — Benchmark & Release | Pending |
| PERF-03 | Phase 6 — Benchmark & Release | Pending |
| PERF-04 | Phase 6 — Benchmark & Release | Pending |
| PERF-05 | Phase 6 — Benchmark & Release | Pending |
| PERF-06 | Phase 6 — Benchmark & Release | Pending |
| PERF-07 | Phase 6 — Benchmark & Release | Pending |
| PERF-08 | Phase 6 — Benchmark & Release | Pending |
| PERF-09 | Phase 6 — Benchmark & Release | Pending |
| PERF-10 | Phase 6 — Benchmark & Release | Pending |
| PERF-11 | Phase 6 — Benchmark & Release | Pending |
| PERF-12 | Phase 6 — Benchmark & Release | Pending |
| PERF-13 | Phase 6 — Benchmark & Release | Pending |
| REL-01 | Phase 6 — Benchmark & Release | Pending |
| REL-02 | Phase 6 — Benchmark & Release | Pending |
| REL-03 | Phase 6 — Benchmark & Release | Pending |
| REL-04 | Phase 6 — Benchmark & Release | Pending |
| SEC-01 | Phase 6 — Benchmark & Release | Pending |
| SEC-02 | Phase 6 — Benchmark & Release | Pending |
| SEC-03 | Phase 6 — Benchmark & Release | Pending |

**Coverage:**
- v1 requirements: 93 total
- Mapped to phases: 93
- Unmapped: 0

**Per-phase requirement counts:**
- Phase 1 — Skeleton: 13 (VAULT-01..06, IDX-02, EDIT-01, EDIT-02, EDIT-04, EDIT-09, UI-04, ERR-01)
- Phase 2 — Vault: 20 (FILE-01..05, FILE-08, FILE-09, EDIT-05, EDIT-06, SYNC-01..08, IDX-07, ERR-03, ERR-04)
- Phase 3 — Search: 14 (IDX-01, IDX-03..06, IDX-08, IDX-09, SRCH-01..06, ERR-02)
- Phase 4 — Links: 9 (LINK-01..09)
- Phase 5 — Polish: 16 (TAG-01..04, UI-01..03, UI-05, UI-06, EDIT-03, EDIT-07, EDIT-08, EDIT-10, EDIT-11, FILE-06, FILE-07)
- Phase 6 — Benchmark & Release: 21 (PERF-01..13, REL-01..04, SEC-01..03, ERR-05)
- Total: 93 ✓

**Note on the requirement count:** the initiating prompt referenced "84 requirements across VAULT, IDX, EDIT, SRCH, LINK, FILE, TAG, SYNC, UI, ERR, PERF, REL, SEC categories". This file as written contains 93 v1 REQ-IDs (6+9+11+6+9+9+4+8+6+5+13+4+3). The roadmap maps all 93 to avoid orphans; if any of the extra 9 were meant to be deferred to v2, that decision needs an explicit edit here before Phase 1 planning.

---
*Requirements defined: 2026-04-11*
*Last updated: 2026-04-11 — traceability filled by gsd-roadmapper*
