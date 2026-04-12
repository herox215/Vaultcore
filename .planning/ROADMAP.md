# Roadmap: VaultCore

**Version:** v0.1 (MVP)
**Created:** 2026-04-11
**Granularity:** standard
**Source spec:** `VaultCore_MVP_Spezifikation_v3.md` (Section 15 milestones M1–M6)

## Overview

VaultCore v0.1 delivers a local, Markdown-first note app built on Tauri 2 + Rust + CodeMirror 6 that stays fluid on vaults of 100,000+ notes. The roadmap maps ~1:1 to the six spec milestones: start with a Tauri skeleton that can open, edit, and auto-save a single file (Phase 1), grow into a full multi-tab vault with a file browser and three-way merge file-watcher (Phase 2), add Tantivy full-text search and a Quick Switcher (Phase 3), layer on the Obsidian-compatible wiki-link graph with backlinks and rename-cascade (Phase 4), polish tags, shortcuts, themes, and the remaining editor quality bits (Phase 5), and finally prove the core value by running all performance budgets against a generated 100k-note vault and producing cross-platform alpha builds (Phase 6). Every phase from 1 to 5 leaves the performance budgets as non-blocking guardrails; Phase 6 is where they become the gate.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Skeleton** - Tauri 2 + CM6 scaffold, open a vault, edit and auto-save a single `.md` file
- [x] **Phase 2: Vault** - File browser tree, multi-tab, split-view, file watcher with three-way merge (completed 2026-04-12)
- [x] **Phase 3: Search** - Tantivy full-text index with AND/OR/NOT, Quick Switcher, versioned rebuild (completed 2026-04-12)
- [x] **Phase 4: Links** - Wiki-link parsing, 3-stage resolution, backlinks panel, rename-cascade (completed 2026-04-12)
- [ ] **Phase 5: Polish** - Tags, themes, fonts, remaining shortcuts, editor quality-of-life
- [ ] **Phase 6: Benchmark & Release** - 100k-note benchmarks, 24h soak, cross-platform alpha builds

## Phase Details

### Phase 1: Skeleton
**Goal**: User can launch VaultCore, open a Markdown vault via native folder dialog, and edit a single `.md` file with auto-save — the entire foundation needed for every later phase.
**Depends on**: Nothing (first phase)
**Requirements**: VAULT-01, VAULT-02, VAULT-03, VAULT-04, VAULT-05, VAULT-06, IDX-02, EDIT-01, EDIT-02, EDIT-04, EDIT-09, UI-04, ERR-01
**Success Criteria** (what must be TRUE):
  1. User launches `tauri dev` (or a packaged build) and sees a Welcome screen with an "Open vault" button and an (initially empty) recent-vaults list
  2. User picks a folder through the native OS dialog and the Welcome screen transitions into the vault view; the chosen path appears in the recent list on the next launch and auto-loads by default
  3. User opens a `.md` file and the CodeMirror 6 editor renders it with Markdown syntax highlighting and inline live-preview (bold/italic/headings/inline code/lists), and keystrokes respond at 60 fps
  4. User edits the file, waits ~2 seconds, and sees the change on disk without pressing save; Cmd/Ctrl+B, Cmd/Ctrl+I, Cmd/Ctrl+K wrap selections as expected
  5. If the last-opened vault path is no longer reachable the app returns to the Welcome screen without crashing and surfaces a toast carrying a `VaultError` variant
**Plans**: 5 plans
Plans:
- [x] 01-00-scaffold-test-infra-PLAN.md — Wave 0: Tauri + Svelte 5 scaffold, Tailwind v4 + CSS variables, strict tsconfig, Vitest + jsdom, every REQ-ID test skeleton (it.todo), Rust module tree + #[ignore] cargo test stubs, RC-02 decision locked
- [x] 01-01-backend-spine-PLAN.md — Wave 1: Full VaultError enum (ERR-01), vault.rs commands (open_vault/get_recent_vaults/get_vault_stats) with canonicalize + FsExt runtime scope, recent-vaults JSON with FIFO-10 + dedupe, files.rs (read_file UTF-8 guard, write_file vault-scope guard, SHA-256 hash return), every Wave 0 cargo stub filled in and green
- [x] 01-02-frontend-welcome-PLAN.md — Wave 2: Typed VaultError TS interface, src/ipc/commands.ts wrappers, four classic writable stores (vault/editor/toast/progress) per D-06/RC-01, UI-SPEC Welcome screen + RecentVaultRow + ToastContainer, App.svelte auto-load flow with VAULT-05 fallback, 21+ Vitest assertions green
- [x] 01-03-editor-autosave-PLAN.md — Wave 3: CodeMirror 6 wrapper with RC-02 explicit extension list (no basicSetup/lineNumbers/foldGutter), theme.ts CSS-variable HighlightStyle (H1=26/H2=22/H3=18), wrapSelection helper with toggle-off for Mod+B/I/K, autoSaveExtension 2s idle debounce on docChanged, CMEditor.svelte storing EditorView in plain `let` (RC-01/Risk-3 mitigation), 10 new EDIT-04/EDIT-09 assertions green
- [x] 01-04-progress-filelist-wireup-PLAN.md — Wave 4: open_vault two-pass walk with throttled vault://index_progress emit and sorted file_list return, typed listenIndexProgress wrapper, UI-SPEC ProgressBar, D-14 flat VaultView + FileListRow with click-to-open, CMEditor onSave → writeFile with toast fallback, end-to-end wire-up, Phase 1 manual verification checkpoint against every ROADMAP success criterion
**UI hint**: yes

### Phase 2: Vault
**Goal**: User can navigate, create, rename, delete, and move files inside a real vault with multi-tab and split-view editing, and the app safely reconciles external edits via a three-way merge driven by the file watcher.
**Depends on**: Phase 1
**Requirements**: FILE-01, FILE-02, FILE-03, FILE-04, FILE-05, FILE-08, FILE-09, EDIT-05, EDIT-06, SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-06, SYNC-07, SYNC-08, IDX-07, ERR-03, ERR-04
**Success Criteria** (what must be TRUE):
  1. User sees a lazy-loaded folder/file tree for the open vault; `.obsidian/` is hidden, symlinks are displayed but not followed, and non-UTF-8 files appear but show a toast when the user tries to open them
  2. User can create, rename, delete-to-`.trash/`, and drag-drop-move files from the sidebar; a rename that would touch wiki-links surfaces a confirmation prompt showing the affected count (the actual link rewrite lands in Phase 4, but the prompt path is wired now)
  3. User can open multiple files in tabs (Cmd/Ctrl+Tab cycles) and arrange two tabs side-by-side in a split view, editing each independently
  4. When an external tool (e.g. Syncthing) rewrites an open file, the change is merged in cleanly and the user sees a "Externe Änderungen wurden eingebunden" toast; when the same region was edited locally, the local state is kept and a "Konflikt in <file> – lokale Version behalten" toast is shown
  5. The app's own writes (auto-save, rename, delete, move) never trigger external-change toasts, and bulk external changes of >500 files raise the indexing progress UI instead of toast-spamming
  6. If the vault folder is unmounted while the app is open, editing is disabled and a toast explains the state without the app crashing; a disk-full write attempt surfaces a toast without losing the in-editor buffer
**Plans**: 6 plans
Plans:
- [x] 02-01-PLAN.md — Wave 1: Rust crate additions (notify-debouncer-full, similar, rayon), list_directory command with lazy-load/dot-filter/symlink detection, VaultState extension (WriteIgnoreList, vault_reachable), watcher + merge module skeletons, frontend TypeScript types and IPC wrappers for all Phase 2 commands/events
- [x] 02-02-PLAN.md — Wave 2: Six Rust file-operation commands (create_file, rename_file, delete_file, move_file, create_folder, count_wiki_links), Sidebar tree with TreeNode/InlineRename, VaultLayout grid shell replacing VaultView, confirmation dialogs, drag-drop move, lucide-svelte icons
- [x] 02-03-PLAN.md — Wave 3: tabStore with split-view state management, TabBar/Tab/EditorPane Svelte components, EditorView Map lifecycle (no remount on tab switch), drag-to-reorder/drag-to-split, Cmd+Tab/Cmd+W keyboard shortcuts
- [x] 02-04-PLAN.md — Wave 4: File watcher (notify-debouncer-full spawn on vault open), write-ignore-list self-filtering in all write commands, bulk-change detection (>500 events/2s), sidebar auto-refresh on external changes, bulk progress UI
- [x] 02-05-PLAN.md — Wave 5: Three-way merge implementation (similar crate, line-level), merge_external_change Tauri command, frontend merge wiring with toasts, vault unmount/reconnect readonly toggle, disk-full resilience, end-to-end manual verification checkpoint
- [x] 02-06-PLAN.md — Wave 6 (gap closure): Fix RenameResult serde camelCase mismatch (CR-01), Sidebar onPathChanged prop wiring (CR-02), German toast text for merge/conflict (ROADMAP SC#4)
**UI hint**: yes

### Phase 3: Search
**Goal**: User can find any note in the vault within tens of milliseconds via either a Tantivy full-text search panel or a fuzzy filename Quick Switcher, backed by an incremental hash-driven indexer.
**Depends on**: Phase 2
**Requirements**: IDX-01, IDX-03, IDX-04, IDX-05, IDX-06, IDX-08, IDX-09, SRCH-01, SRCH-02, SRCH-03, SRCH-04, SRCH-05, SRCH-06, ERR-02
**Success Criteria** (what must be TRUE):
  1. Opening a vault indexes every `.md` file into Tantivy and the in-memory metadata store, with a live progress bar showing filename and `12,483 / 100,000`-style counter; non-UTF-8 files are skipped silently
  2. User presses Cmd/Ctrl+Shift+F, types a query using AND/OR/NOT and `"exact phrase"` syntax, and sees ranked results with contextual snippets; clicking a result opens the note at the match location
  3. User presses Cmd/Ctrl+P and a fuzzy filename Quick Switcher responds to every keystroke without perceptible lag (budget < 10 ms on 100k files, proven in Phase 6)
  4. Re-opening the vault on a subsequent launch uses the cached Tantivy index and only re-parses files whose SHA-256 hash has changed; a schema bump in `index_version.json` triggers an automatic delete-and-rebuild with the same progress UI, and a manual `rebuild_index` command is available
  5. Index writes are serialized through a single central queue — two concurrent changes to the same file never race each other — and an IndexCorrupt detection path kicks off the automatic rebuild without user intervention
**Plans**: 4 plans
Plans:
- [x] 03-01-PLAN.md — Wave 1: Rust indexer module (Tantivy schema, central mpsc queue, FileIndex in-memory store, pulldown-cmark parser, index_version.json sidecar), Cargo deps (tantivy, nucleo-matcher, pulldown-cmark), open_vault integration with real Tantivy indexing
- [x] 03-02-PLAN.md — Wave 2: Three Rust search commands (search_fulltext with SnippetGenerator, search_filename with nucleo-matcher, rebuild_index), frontend TypeScript types, IPC wrappers, searchStore
- [x] 03-03-PLAN.md — Wave 3: Sidebar tab switching (Dateien/Suche), SearchPanel with 200ms debounce live search, SearchInput, SearchResults with counter and overflow hint, SearchResultRow with snippet highlights, rebuild button UX, Cmd+Shift+F shortcut
- [x] 03-04-PLAN.md — Wave 3: Quick Switcher modal (Cmd+P) with fuzzy filename matching, recents on empty input, keyboard navigation, CM6 flash highlight decoration for scroll-to-match, manual verification checkpoint
**UI hint**: yes

### Phase 4: Links
**Goal**: User experiences a fully Obsidian-compatible wiki-link graph — clickable `[[links]]`, backlinks, unresolved-link highlighting, `[[` autocomplete, and rename-cascade that rewrites every link to a moved note.
**Depends on**: Phase 3
**Requirements**: LINK-01, LINK-02, LINK-03, LINK-04, LINK-05, LINK-06, LINK-07, LINK-08, LINK-09
**Success Criteria** (what must be TRUE):
  1. `[[Note]]` and `[[Note|alias]]` are rendered as clickable links in the editor; unresolved targets are styled in a distinct color; clicking a resolved link opens the target note in a new tab
  2. Link resolution follows the spec's 3-stage rule (same folder → shortest relative path → alphabetical tiebreak) and matches what Obsidian would resolve on the same vault
  3. Typing `[[` opens an autocomplete list that filters filenames as the user types, and the backlinks panel for the active note lists every other note that links into it
  4. Renaming or moving a file through the sidebar prompts "X links will be updated. Continue?" and, on confirm, rewrites every wiki-link pointing at the old path so nothing becomes unresolved after the rename
  5. The `get_unresolved_links` command returns a complete list of dangling links for the vault, and the link graph stays accurate as notes are created, edited, and deleted (no full rescan required)
**Plans**: 4 plans
Plans:
- [x] 04-01-PLAN.md — Wave 1: Rust LinkGraph module (ParsedLink, 3-stage resolve_link, update_file, remove_file, get_backlinks, get_unresolved), IndexCoordinator integration, 5 IPC commands (get_backlinks, get_outgoing_links, get_unresolved_links, suggest_links, update_links_after_rename), TypeScript types and IPC wrappers, unit tests for resolution algorithm
- [x] 04-02-PLAN.md — Wave 2: CM6 wikiLink ViewPlugin (Decoration.mark with accent/muted classes via RangeSetBuilder), lezer syntax-tree code-block exclusion, mousedown event handler dispatching wiki-link-click CustomEvent, tailwind.css classes .cm-wikilink-resolved/.cm-wikilink-unresolved, setResolvedPaths module state for resolution lookup
- [x] 04-03-PLAN.md — Wave 2: CM6 wikiLinkCompletionSource (triggered by matchBefore(/[[([^]]*)/) excluding alias), suggestLinks IPC integration (nucleo fuzzy), autocompletion() extension wired into buildExtensions, popup CSS matching UI-SPEC (360px, filename bold + path grey, Keine Dateien gefunden empty state)
- [x] 04-04-PLAN.md — Wave 3: backlinksStore (localStorage persistence for open/width), BacklinksPanel + BacklinkRow components (German copy per UI-SPEC), RightSidebar component, VaultLayout 5-column grid extension with Cmd+Shift+B toggle, EditorPane wiki-link-click listener (tabStore.openTab for resolved, createFile+openTab for unresolved), TreeNode rename/move cascade with German confirmation and partial-error toast, end-to-end human verification checkpoint
**UI hint**: yes

### Phase 04.1: Phase 4 UAT Bugfixes (INSERTED)

**Goal:** [Urgent work - to be planned]
**Requirements**: TBD
**Depends on:** Phase 4
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 04.1 to break down)

### Phase 5: Polish
**Goal**: User experiences VaultCore as a polished daily driver — tag panel, dark/light themes, configurable typography, full keyboard-shortcut coverage, persistent sort/expand state, and all remaining editor niceties.
**Depends on**: Phase 4
**Requirements**: TAG-01, TAG-02, TAG-03, TAG-04, UI-01, UI-02, UI-03, UI-05, UI-06, EDIT-03, EDIT-07, EDIT-08, EDIT-10, EDIT-11, FILE-06, FILE-07
**Success Criteria** (what must be TRUE):
  1. Inline `#tag` / `#parent/child` and YAML frontmatter `tags: [a, b]` are extracted into a tag panel in the sidebar with usage counts; clicking a tag runs a search that shows every note carrying it
  2. User can toggle dark and light mode at runtime, pick a font family and size, and collapse/expand the sidebar with Cmd/Ctrl+\; the choices persist across restarts
  3. Every keyboard shortcut listed in spec Section 13 (including Cmd/Ctrl+N for new note, undo/redo inside each tab, fenced-code-block language highlighting visible in the editor) works end-to-end
  4. Before each auto-save the on-disk hash is compared to the expected hash; a mismatch cleanly routes through the Phase 2 merge path instead of clobbering the external change
  5. File browser sort order (name / modified / created) and folder expand/collapse state are remembered across sessions, and opening a 10,000-line note remains smooth with no size-based degradation
**Plans**: 8 plans
Plans:
- [x] 05-00-PLAN.md — Wave 0: Cargo/npm deps (serde_yml, @codemirror/language-data, @fontsource/*), DirEntry timestamps extension, theme.ts fontSize → var(--vc-font-size), @fontsource CSS import ordering
- [x] 05-01-PLAN.md — Wave 2: TagIndex Rust module (inline + YAML frontmatter extraction), IndexCoordinator integration, watcher UpdateTags/RemoveTags dispatch, list_tags IPC + TS types (TAG-01, TAG-02, TAG-03)
- [x] 05-02-PLAN.md — Wave 2: Dark palette under :root[data-theme=dark], themeStore + settingsStore, Settings modal foundation with Erscheinungsbild + Schrift sections (UI-01, UI-02)
- [x] 05-03-PLAN.md — Wave 3: Central SHORTCUTS registry refactor of VaultLayout.handleKeydown, Cmd+N new-note, Cmd+\ sidebar toggle, Settings modal Tastaturkürzel table, per-tab undo/redo isolation regression test (UI-03, UI-05, EDIT-11, EDIT-07)
- [x] 05-04-PLAN.md — Wave 4: Tag panel UI + third sidebar tab, nested tag tree, empty state, tag-click search wiring (TAG-03 UI, TAG-04)
- [x] 05-05-PLAN.md — Wave 3: Fenced-code-block per-language highlighting via @codemirror/language-data + EDIT-08 10k-line regression test (EDIT-03, EDIT-08)
- [ ] 05-06-PLAN.md — Wave 5: Hash-verify merge path in autoSave — get_file_hash IPC, async-aware autoSaveExtension, EditorPane merge-on-mismatch branch reusing Phase 2 toasts (EDIT-10)
- [ ] 05-07-PLAN.md — Wave 5: treeState.ts sort+persist library, SortMenu popover in sidebar topbar, TreeNode expand persistence, UI-06 regression audit (FILE-06, FILE-07, UI-06)
**UI hint**: yes

### Phase 6: Benchmark & Release
**Goal**: Prove VaultCore's core value — fluid at 100,000 notes — by hitting every spec Section 7 performance budget on a generated 100k-note vault, passing a 24-hour soak, and shipping cross-platform alpha builds with clean test suites and verified zero-network behavior.
**Depends on**: Phase 5
**Requirements**: PERF-01, PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07, PERF-08, PERF-09, PERF-10, PERF-11, PERF-12, PERF-13, REL-01, REL-02, REL-03, REL-04, SEC-01, SEC-02, SEC-03, ERR-05
**Success Criteria** (what must be TRUE):
  1. A reproducible generator produces a 100,000-note vault (~500 words/file) in CI, and against that vault VaultCore hits every performance budget from spec Section 7: cold start < 3 s, warm start < 5 s, open note < 100 ms, keystroke < 16 ms, full-text search < 50 ms, Quick Switcher < 10 ms, backlinks < 20 ms, link autocomplete < 10 ms, initial indexing < 60 s, incremental update < 5 ms, RAM idle < 100 MB, RAM active < 250 MB
  2. A 24-hour soak test runs against an open 100k vault with no crash, no memory leak beyond budget, and at most 2 seconds of unsaved content recoverable after a forced kill
  3. Alpha builds are produced for macOS (Intel + Apple Silicon), Windows 10/11, and Linux (Ubuntu 22.04+ and Fedora 38+), all of which boot, open a vault, and search successfully on their respective platforms
  4. All unit tests (parser, indexer, link graph, merge engine, write-ignore-list), the 100k-vault integration/benchmark gate, and frontend component tests (editor, sidebar, welcome screen) are green in CI
  5. A security audit of the built binaries confirms zero network syscalls, zero telemetry code, and that nothing under the vault ever leaves the local filesystem
**Plans**: TBD
**UI hint**: no

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Skeleton | 5/5 | Complete | - |
| 2. Vault | 6/6 | Complete   | 2026-04-12 |
| 3. Search | 4/4 | Complete   | 2026-04-12 |
| 4. Links | 4/4 | Complete   | 2026-04-12 |
| 5. Polish | 6/8 | In Progress|  |
| 6. Benchmark & Release | 0/TBD | Not started | - |

## Coverage

- v1 requirements in REQUIREMENTS.md: 93 total (VAULT 6, IDX 9, EDIT 11, SRCH 6, LINK 9, FILE 9, TAG 4, SYNC 8, UI 6, ERR 5, PERF 13, REL 4, SEC 3)
- Mapped across 6 phases: 93 / 93
- Orphaned: 0
- Duplicates: 0

**Note on requirement count:** The initiating prompt referenced "84 requirements"; the authoritative `REQUIREMENTS.md` file actually contains 93 v1 REQ-IDs. The roadmap maps all 93.

**Non-blocking guardrails:** Performance budgets (PERF-01..13) are formally validated in Phase 6 but must be watched as non-blocking indicators in Phases 1–5 — if Phase 3 search routinely takes 500 ms on a 10k vault, Phase 6 will not hit 50 ms on 100k.
