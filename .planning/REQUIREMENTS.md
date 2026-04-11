# Requirements: VaultCore

**Defined:** 2026-04-11
**Core Value:** Stay fluid at 100,000+ notes — open, search, link, and edit a vault of that size without perceptible lag.

## v1 Requirements

Requirements for MVP v0.1. Each maps to a roadmap phase. Sourced from `VaultCore_MVP_Spezifikation_v3.md`.

### Vault

- [ ] **VAULT-01**: User can open a vault folder via a native OS folder picker
- [ ] **VAULT-02**: Recent-vaults list is persisted as JSON in the Tauri app-data directory
- [ ] **VAULT-03**: On startup, the last opened vault is loaded automatically if still reachable
- [ ] **VAULT-04**: When no vault is open, a Welcome screen is shown with an "Open vault" button and the recent list
- [ ] **VAULT-05**: If the last vault is no longer reachable, the app falls back to the Welcome screen without crashing
- [ ] **VAULT-06**: A `VaultInfo` / `VaultStats` command surfaces vault path and note count

### Indexing

- [ ] **IDX-01**: Opening a vault indexes all `.md` files into Tantivy and into the in-memory metadata index
- [ ] **IDX-02**: A progress bar with filename and counter ("12,483 / 100,000") is shown during indexing, fed by Tauri events
- [ ] **IDX-03**: Incremental re-indexing uses SHA-256 hash comparison; only changed files are re-parsed
- [ ] **IDX-04**: The in-memory index (FileIndex, LinkGraph, TagIndex) is rebuilt from disk on every cold start
- [ ] **IDX-05**: Tantivy index stores an `index_version.json` sidecar; on schema mismatch the index is deleted and rebuilt with progress UI
- [ ] **IDX-06**: All Tantivy writes go through a single central queue (never two concurrent writes for the same file)
- [ ] **IDX-07**: The `.obsidian/` folder is ignored by both the file browser and the indexer
- [ ] **IDX-08**: Non-UTF-8 files are shown in the browser but skipped by the indexer
- [ ] **IDX-09**: User can trigger a manual index rebuild via `rebuild_index` command

### Editor

- [ ] **EDIT-01**: CodeMirror 6 renders Markdown with syntax highlighting (headings, bold, italic, code, lists, tables GFM)
- [ ] **EDIT-02**: Inline live-preview of bold, italic, headings, inline code, and lists
- [ ] **EDIT-03**: Fenced code blocks render with per-language syntax highlighting
- [ ] **EDIT-04**: Keyboard shortcuts work: Cmd/Ctrl+B (bold), Cmd/Ctrl+I (italic), Cmd/Ctrl+K (link)
- [ ] **EDIT-05**: Multi-tab: user can open multiple notes simultaneously and switch with Cmd/Ctrl+Tab
- [ ] **EDIT-06**: Split-view: two notes can be displayed and edited side-by-side
- [ ] **EDIT-07**: Undo/redo work within each tab (provided by CM6)
- [ ] **EDIT-08**: There is no file-size limit — a 10,000-line note opens without degradation
- [ ] **EDIT-09**: Auto-save writes the active note to disk every 2 seconds (no manual save, no dirty indicator)
- [ ] **EDIT-10**: Before each auto-save, the on-disk hash is compared to the expected hash; mismatch triggers the merge path
- [ ] **EDIT-11**: New note creation via Cmd/Ctrl+N

### Search

- [ ] **SRCH-01**: Cmd/Ctrl+Shift+F opens the full-text search panel
- [ ] **SRCH-02**: Full-text search results include filename, relevance rank, and a contextual snippet
- [ ] **SRCH-03**: Search supports AND, OR, NOT, and phrase queries (`"exact text"`)
- [ ] **SRCH-04**: Cmd/Ctrl+P opens the Quick Switcher with fuzzy filename matching
- [ ] **SRCH-05**: Quick Switcher and full-text search are backed by separate commands (`search_filename`, `search_fulltext`)
- [ ] **SRCH-06**: Clicking a search result opens the note at the match location

### Links

- [ ] **LINK-01**: `[[Note]]` and `[[Note|alias]]` are parsed and rendered as clickable wiki-links
- [ ] **LINK-02**: Link resolution uses 3-stage shortest-path: (1) exact match in the same folder, (2) shortest relative path, (3) alphabetical tiebreak
- [ ] **LINK-03**: Clicking a resolved wiki-link opens the target note in a new tab
- [ ] **LINK-04**: Unresolved wiki-links are visually distinct (different color) in the editor
- [ ] **LINK-05**: Typing `[[` opens an autocomplete list of matching filenames
- [ ] **LINK-06**: Backlinks panel shows every note whose parsed links point to the currently-active note
- [ ] **LINK-07**: `get_unresolved_links` command returns all dangling links in the vault
- [ ] **LINK-08**: The link graph is built from disk on startup (adjacency list) and updated incrementally on file changes
- [ ] **LINK-09**: Renaming a file updates every wiki-link pointing at it after a confirmation dialog ("X links will be updated. Continue?")

### Files

- [ ] **FILE-01**: The sidebar shows a folder/file tree for the open vault with lazy loading of subtrees
- [ ] **FILE-02**: User can create a new file from the file browser
- [ ] **FILE-03**: User can rename files (triggers the LINK-09 cascade when links are affected)
- [ ] **FILE-04**: Deleting a file moves it to `<vault>/.trash/` rather than permanently removing it
- [ ] **FILE-05**: User can move files by drag-and-drop
- [ ] **FILE-06**: Sorting options: name, modified date, created date; order is remembered
- [ ] **FILE-07**: Folder expand/collapse state is persisted across sessions
- [ ] **FILE-08**: Symbolic links are displayed but not followed
- [ ] **FILE-09**: Non-UTF-8 files are displayed; attempting to open one shows a toast error and does not load them into the editor

### Tags

- [ ] **TAG-01**: Inline tags (`#tag` and nested `#parent/child`) are extracted from note bodies
- [ ] **TAG-02**: YAML frontmatter tags (`tags: [a, b]`) are extracted (YAML only, no TOML)
- [ ] **TAG-03**: A tag panel in the sidebar lists all tags in the vault with usage counts
- [ ] **TAG-04**: Clicking a tag in the panel runs a search for all notes carrying it

### Sync / Concurrency

- [ ] **SYNC-01**: File watcher (notify crate) detects external changes to vault files
- [ ] **SYNC-02**: Write-ignore-list suppresses watcher events caused by backend writes (auto-save, rename, delete, move) with a 100 ms debounce window
- [ ] **SYNC-03**: Bulk external changes are debounced over a 200 ms window and processed as a batch
- [ ] **SYNC-04**: Batch parsing is parallelized with rayon; the full batch produces a single Tantivy commit
- [ ] **SYNC-05**: Batches of > 500 files trigger the progress UI
- [ ] **SYNC-06**: A three-way merge is used when an open file is modified externally; conflict detection is based on CM6 `docChanged`, not cursor position
- [ ] **SYNC-07**: On true conflict at the same location, the local editor state wins
- [ ] **SYNC-08**: Clean merges surface a toast "Externe Änderungen wurden eingebunden"; lossy conflicts surface "Konflikt in <file> – lokale Version behalten"

### UI / UX

- [ ] **UI-01**: Dark mode and Light mode are implemented and can be toggled at runtime
- [ ] **UI-02**: Font family and font size are configurable
- [ ] **UI-03**: Sidebar can be collapsed/expanded with Cmd/Ctrl+\
- [ ] **UI-04**: Toast component supports error, clean-merge, and conflict variants, auto-dismisses after 5 s, and is manually dismissable
- [ ] **UI-05**: All MVP keyboard shortcuts from spec Section 13 are wired up
- [ ] **UI-06**: All user-facing surfaces (errors, merge notices, rename prompt) use the unified toast / dialog components

### Errors

- [ ] **ERR-01**: `VaultError` enum exists in Rust with all variants from spec Section 5 (FileNotFound, PermissionDenied, DiskFull, IndexCorrupt, VaultUnavailable, MergeConflict, InvalidEncoding, Io)
- [ ] **ERR-02**: Index-corrupt detection triggers an automatic rebuild with progress UI
- [ ] **ERR-03**: If the vault folder becomes unreachable, the app stays open but disables editing and shows a toast
- [ ] **ERR-04**: Disk-full failures during auto-save surface a toast but do not lose editor content
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

Populated by the roadmapper. Empty until ROADMAP.md is created.

| Requirement | Phase | Status |
|-------------|-------|--------|
| (to be filled by gsd-roadmapper) | | |

**Coverage:**
- v1 requirements: 84 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 84 ⚠️ (will be resolved in Step 8)

---
*Requirements defined: 2026-04-11*
*Last updated: 2026-04-11 after initial definition*
