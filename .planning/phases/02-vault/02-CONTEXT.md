# Phase 2: Vault - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

User can navigate, create, rename, delete, and move files inside a real vault with multi-tab and split-view editing, and the app safely reconciles external edits via a three-way merge driven by the file watcher.

**In scope:** FILE-01..05, FILE-08, FILE-09, EDIT-05, EDIT-06, SYNC-01..08, IDX-07, ERR-03, ERR-04.

**Explicitly NOT in scope:** Full-text search (Phase 3), wiki-link parsing/graph/autocomplete (Phase 4), dark mode / remaining shortcuts / polish (Phase 5), performance benchmarks (Phase 6).

</domain>

<decisions>
## Implementation Decisions

### Sidebar Tree (FILE-01)
- **D-01:** **Lazy-load** — only root-level entries loaded initially. Subtrees load on expand (click/arrow). This keeps memory low and startup fast for vaults with 100k+ files.
- **D-02:** **Left sidebar, resizable** — Obsidian-style drag-handle. Width persisted across sessions (in app settings, not vault-specific). Collapsible via toggle button or shortcut.
- **D-03:** **Sort: folders first, then alphabetical** — standard convention matching VS Code and Obsidian. Case-insensitive sort within each group.
- **D-04:** **All dot-prefixed directories hidden** — `.obsidian/`, `.trash/`, `.git/`, `.vscode/`, etc. are not rendered in the tree. Files starting with `.` are also hidden. No toggle in Phase 2 (Phase 5 could add a "show hidden" option).
- **D-05:** Symlinks are **displayed** in the tree (per spec FILE-01) but **not followed** during recursive operations (delete, move). Opening a symlinked `.md` file reads the target content normally.

### Multi-Tab + Split-View (EDIT-05, EDIT-06)
- **D-06:** **Obsidian-style tab bar** — tabs at top of editor area, drag-to-reorder, middle-click or X closes, unsaved tabs show dot indicator. `Cmd/Ctrl+Tab` cycles tabs, `Cmd/Ctrl+W` closes active tab. No hard max-tab limit (scroll overflow if needed).
- **D-07:** **Drag tab to editor edge for split** — dragging a tab to the left or right edge of the editor area creates a 2-pane horizontal split. Drag back to rejoin. Only 2 panes supported in Phase 2 (no grid/vertical split). Each pane has its own tab bar.
- **D-08:** **New `tabStore`** — dedicated writable store managing: `tabs: Tab[]` (id, filePath, isDirty, lastSaved, scrollPos), `activeTabId`, `splitState: { left: tabId[], right: tabId[], activePane }`. `editorStore` stays focused on CM6-specific state (cursor position, undo history ref). This is a clean separation — `tabStore` owns layout, `editorStore` owns editor internals.
- **D-09:** Tab state is **not persisted across restarts** in Phase 2. App opens to the vault view with no tabs open (user picks a file). Phase 5 may add session restore.

### File Watcher + Three-Way Merge (SYNC-01..08)
- **D-10:** Use the `notify` crate (v7+) for cross-platform file watching. Watch the entire vault recursively. Debounce events using notify's built-in debouncer (~200ms). Handle `Create`, `Modify`, `Remove`, `Rename` event kinds.
- **D-11:** **Auto-merge for non-conflicting external changes, keep local on conflict.** When an open file is externally modified:
  1. Read the new disk content.
  2. Compute three-way diff using `similar` crate (base = last-saved content, left = current editor buffer, right = new disk content).
  3. If changes don't overlap: apply merge silently + toast "Externe Änderungen wurden eingebunden".
  4. If same region modified in both: **keep local version** + toast "Konflikt in <file> – lokale Version behalten".
  5. Update the "base" snapshot to the merged result for future diffs.
- **D-12:** **Write-token + time-window for self-filtering.** Before each own write (auto-save, explicit save, rename/move/delete):
  1. Record `(path, timestamp)` in a short-lived in-memory set.
  2. Watcher ignores any event for that path arriving within ~100ms of the recorded timestamp.
  3. Tokens auto-expire after 500ms to prevent memory leak.
- **D-13:** **Bulk-change threshold: 500 events in 2 seconds.** When the watcher receives >500 file events within a 2s sliding window:
  1. Switch from per-file toasts to the indexing progress UI (reuse Phase 1's ProgressBar).
  2. Batch-process all pending events.
  3. Resume per-file behavior once the burst subsides.
  This handles Syncthing syncs, large git operations, and similar bulk changes gracefully.
- **D-14:** **Vault unmount → disable editing + explanatory toast.** When the vault folder becomes unreachable (ERR-03):
  1. All open editors switch to readonly mode.
  2. Toast: "Vault nicht erreichbar — Bearbeitung deaktiviert" (or equivalent per locale).
  3. In-editor buffers are preserved in memory (no data loss).
  4. Watcher attempts periodic reconnect. On reconnect: re-enable editing + toast confirmation.
  5. App does NOT navigate away from vault view — tabs and splits are preserved.

### File Operations (FILE-02..05, FILE-08, FILE-09)
- **D-15:** **Delete moves to `.trash/` inside the vault** (Obsidian-compatible). `.trash/` is auto-created on first delete. Hidden in sidebar per D-04 (dot-directory rule). Confirmation dialog: "Datei in .trash/ verschieben?" with filename shown.
- **D-16:** **Rename shows wiki-link count prompt.** When renaming a file: scan all `.md` files for `[[old-filename]]` patterns (simple regex, no full link parser — that's Phase 4). If count > 0: prompt "X Wiki-Links verweisen auf diese Datei. Trotzdem umbenennen? (Links werden in Phase 4 automatisch aktualisiert)". Phase 4 adds the actual rewrite logic.
- **D-17:** **Drag-drop in sidebar = Move** (Obsidian-style). No copy on drag. Modifier-key copy is deferred to Phase 5. Move updates the file path on disk and any open tab's `filePath`.
- **D-18:** **New file in selected folder.** Right-click → "Neue Datei" or toolbar button creates `Unbenannt.md` in the currently selected/focused folder. Filename is immediately inline-editable (focus + select-all). If no folder is selected: create in vault root. If `Unbenannt.md` already exists: auto-suffix (`Unbenannt 1.md`, `Unbenannt 2.md`, ...).
- **D-19:** **New folder** via right-click → "Neuer Ordner" with inline rename. Same pattern as new file.

### Crate Additions
- **D-20:** Phase 2 adds to `Cargo.toml`: `notify` (v7, file watching), `similar` (three-way merge/diff). No other new crates unless research identifies a specific need.

### Claude's Discretion
The following are left for Claude to decide during planning and execution:
- **Sidebar visual details** — icons (file/folder/chevron), hover states, selected highlight, indentation depth per level, animation on expand/collapse.
- **Tab bar visual details** — tab max-width, truncation strategy for long filenames, close-button visibility (always vs. hover), active-tab styling.
- **Split-view resize** — whether the split divider is draggable to resize panes, or fixed 50/50.
- **Watcher debounce tuning** — exact debounce interval for `notify` (suggested ~200ms, but Claude can adjust based on testing).
- **Three-way merge algorithm details** — exact `similar` API usage, how to handle line-level vs. character-level diffs.
- **Inline rename UX** — exact keyboard handling (Enter confirms, Escape cancels, Tab?), validation (no `/` or `\` in filenames, `.md` extension enforced or optional).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### VaultCore Specification
- `VaultCore_MVP_Spezifikation_v3.md` — Full MVP spec. Relevant sections for Phase 2:
  - §4 (File Management), §6 (File Watcher / Sync), §5 (Error Handling — ERR-03, ERR-04)
  - §10 (Directory Layout — Sidebar, Tabs components)
  - §17 (Entscheidungslog — key decisions)

### Planning Artifacts
- `.planning/REQUIREMENTS.md` — Full requirement list with Phase 2 traceability (FILE-01..05, FILE-08, FILE-09, EDIT-05, EDIT-06, SYNC-01..08, IDX-07, ERR-03, ERR-04)
- `.planning/phases/01-skeleton/01-CONTEXT.md` — Phase 1 decisions (D-01..D-23) that constrain Phase 2 (store patterns, event conventions, error handling)
- `.planning/phases/01-skeleton/01-RESEARCH.md` — Phase 1 research (Tauri 2 patterns, Svelte 5 + CM6 integration — relevant for extending)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/Toast/` — Working toast surface with 3 variants (error/warning/info). Reuse for merge/conflict/unmount toasts.
- `src/components/Progress/ProgressBar.svelte` — Reuse for bulk-change progress UI (D-13).
- `src/ipc/commands.ts` — Typed IPC wrapper pattern. Extend with new commands (create_file, rename_file, delete_file, move_file, list_directory).
- `src/ipc/events.ts` — Event listener pattern (`listenIndexProgress`). Extend with `listenFileChange`, `listenVaultStatus`.
- `src-tauri/src/commands/files.rs` — `read_file` / `write_file` with vault-scope guard. Extend with CRUD commands.
- `src-tauri/src/commands/vault.rs` — `open_vault` with `VaultState` mutex. Extend with watcher initialization.
- `src-tauri/src/error.rs` — 8-variant `VaultError` enum. May need new variants (e.g., `FileExists`, `DirectoryNotEmpty`).

### Established Patterns
- **State:** Classic `writable` stores (D-06/RC-01 from Phase 1). New `tabStore` follows same pattern.
- **IPC:** `invoke<T>("command_name", { args })` with typed wrappers. All commands return `Result<T, VaultError>`.
- **Events:** Tauri event system with `vault://` prefix convention (from D-21 Phase 1).
- **Error routing:** All errors → toast surface (unified error UI from Phase 1).
- **Commits:** Conventional commits with `feat(phase)/fix(phase)/test(phase)` prefixes.

### Integration Points
- `src/App.svelte` — Currently routes between WelcomeScreen and VaultView. Must be refactored to support Sidebar + Tabs + Editor layout.
- `src/components/Welcome/VaultView.svelte` — Phase 1's flat file list. **Replaced entirely** by Sidebar + TabBar + EditorPane(s).
- `src/store/vaultStore.ts` — Currently holds flat `fileList: string[]`. Needs to support tree structure for lazy-load sidebar.
- `src/store/editorStore.ts` — Currently single-file. `tabStore` takes over layout; editorStore scope narrows to per-tab CM6 state.

</code_context>

<specifics>
## Specific Ideas

- Three-way merge toasts use German text as shown in Success Criteria: "Externe Änderungen wurden eingebunden" and "Konflikt in <file> – lokale Version behalten". Locale handling is Phase 5 material; hardcode German for now.
- Rename wiki-link count uses simple regex `\[\[filename\]\]` — not a full link parser. Phase 4's link parser will supersede this.
- `.trash/` follows Obsidian convention exactly — flat destination (no path-preserving subfolder structure). If user deletes `foo/bar/note.md`, it moves to `.trash/note.md` (with auto-suffix on collision).

</specifics>

<deferred>
## Deferred Ideas

- **Show hidden files toggle** — Phase 5 could add a sidebar toggle to show dot-prefixed directories/files.
- **Tab session restore** — Reopen tabs from last session on app restart. Phase 5.
- **Alt+Drag = Copy** — Modifier-key drag for copy instead of move. Phase 5.
- **Vertical split / grid layout** — Phase 5 or later.
- **Trash management UI** — View and restore items from `.trash/`. Phase 5.

</deferred>

---

*Phase: 02-vault*
*Context gathered: 2026-04-12*
