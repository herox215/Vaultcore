---
phase: 02-vault
verified: 2026-04-12T13:00:00Z
status: gaps_found
score: 4/6
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/6
  gaps_closed: []
  gaps_remaining:
    - "RenameResult serde field name mismatch (CR-01)"
    - "Sidebar.svelte undefined onPathChanged prop (CR-02)"
    - "Toast messages in English instead of German (ROADMAP SC#4)"
  regressions: []
gaps:
  - truth: "User can create, rename, delete-to-.trash/, and drag-drop-move files from the sidebar; a rename that would touch wiki-links surfaces a confirmation prompt showing the affected count"
    status: failed
    reason: "Two compounding defects break the rename flow: (1) RenameResult struct is missing #[serde(rename_all = \"camelCase\")] so Rust serializes {new_path, link_count} but TypeScript reads .newPath and .linkCount — both are always undefined, so the wiki-link count is always 0/falsy and the confirmation prompt never fires; (2) Sidebar.svelte passes {onPathChanged} shorthand to TreeNode (line 213) but the defined function is handlePathChanged (line 156) — onPathChanged is undefined in scope, so renaming a file never propagates the new path back to the sidebar tree."
    artifacts:
      - path: "src-tauri/src/commands/files.rs"
        issue: "RenameResult struct at line 279 derives serde::Serialize but lacks #[serde(rename_all = \"camelCase\")], causing field names to serialize as new_path/link_count (snake_case) while TypeScript expects newPath/linkCount (camelCase)"
      - path: "src/components/Sidebar/Sidebar.svelte"
        issue: "Line 213: {onPathChanged} shorthand passes undefined to TreeNode because no onPathChanged variable exists in scope — the function is named handlePathChanged (line 156)"
    missing:
      - "Add #[serde(rename_all = \"camelCase\")] to RenameResult in src-tauri/src/commands/files.rs"
      - "Change {onPathChanged} to onPathChanged={handlePathChanged} in Sidebar.svelte line 213"
  - truth: "When an external tool rewrites an open file, the change is merged in cleanly and the user sees a 'Externe Änderungen wurden eingebunden' toast; when the same region was edited locally, the local state is kept and a 'Konflikt in <file> – lokale Version behalten' toast is shown"
    status: failed
    reason: "The merge logic is fully wired and functional, but the toast messages use English strings ('External changes merged into {filename}.' and 'Conflict in {filename} — local version kept.') instead of the German strings mandated by ROADMAP Success Criterion #4 and explicitly required by CONTEXT.md ('hardcode German for now')."
    artifacts:
      - path: "src/components/Editor/EditorPane.svelte"
        issue: "Line 271: uses English 'External changes merged into ${filename}.' — ROADMAP SC#4 requires German 'Externe Änderungen wurden eingebunden'; Line 278: uses English 'Conflict in ${filename} — local version kept.' — ROADMAP SC#4 requires German 'Konflikt in ${filename} – lokale Version behalten'"
    missing:
      - "Change line 271 message to: `Externe Änderungen wurden in ${filename} eingebunden.`"
      - "Change line 278 message to: `Konflikt in ${filename} – lokale Version behalten.`"
human_verification:
  - test: "Run `pnpm tauri dev`, open a vault, verify the sidebar renders a lazy-loaded folder/file tree with folders first, alphabetical sort, and .obsidian/.git/.trash hidden"
    expected: "Sidebar shows only non-dot entries; root folders expand lazily on click; no .obsidian or .git visible"
    why_human: "Requires running Tauri dev build and real filesystem interaction"
  - test: "Create a file via sidebar New file button, rename it (note: rename path propagation is currently broken — CR-01/CR-02), drag it to another folder, then delete it via context menu"
    expected: "Inline rename input appears; delete moves to .trash/ with confirmation dialog; drag-drop move updates sidebar tree. Note: rename will appear to work but wiki-link prompt will not appear and the sidebar tree will not update after rename."
    why_human: "UI interaction flow requires visual inspection in Tauri window"
  - test: "Open 3+ files in tabs, press Cmd/Ctrl+Tab to cycle, press Cmd/Ctrl+W to close; drag a tab to the right edge to create a split view"
    expected: "Tabs open and cycle correctly; split view shows two independent editor panes"
    why_human: "Requires runtime tab interaction in Tauri window"
  - test: "With a file open in VaultCore, externally modify it (e.g. echo 'change' >> file.md), observe toast"
    expected: "Toast appears — BUT note it will display English ('External changes merged into...') not German as required by ROADMAP SC#4 until that gap is fixed"
    why_human: "Requires external file modification and observation of toast behavior"
  - test: "Edit a file in VaultCore and in an external editor simultaneously (same line), save both — verify local version is kept"
    expected: "Conflict toast appears with local content preserved in editor"
    why_human: "Requires coordinated timing between two editors and observation of the conflict resolution"
  - test: "With VaultCore open and a file in an editor, simulate vault becoming unreachable (rename the vault folder in another terminal)"
    expected: "Editors switch to readonly (overlay appears), 'Vault unavailable. Editing disabled.' toast appears"
    why_human: "Requires live filesystem manipulation and observation of app state"
---

# Phase 2: Vault Verification Report (Re-verification)

**Phase Goal:** User can navigate, create, rename, delete, and move files inside a real vault with multi-tab and split-view editing, and the app safely reconciles external edits via a three-way merge driven by the file watcher.
**Verified:** 2026-04-12T13:00:00Z
**Status:** gaps_found
**Re-verification:** Yes — after gap closure attempt (no gaps closed)

## Re-verification Summary

Previous verification found 3 gaps. All 3 gaps remain unfixed in the codebase. No regressions found in the 4 previously-passing truths.

| Gap | Previous Status | Current Status |
|-----|-----------------|----------------|
| CR-01: RenameResult serde mismatch | FAILED | STILL FAILED |
| CR-02: Sidebar undefined onPathChanged | FAILED | STILL FAILED |
| English toast messages instead of German | FAILED | STILL FAILED |

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User sees a lazy-loaded folder/file tree; .obsidian hidden; symlinks displayed but not followed; non-UTF-8 files show toast | VERIFIED (regression check passed) | `list_directory_impl` in tree.rs: dot-prefix filter via `starts_with('.')`, `symlink_metadata()` for `is_symlink`, folder-first sort. TreeNode dispatches toast on non-md click. |
| 2 | User can create, rename, delete-to-.trash/, drag-drop-move files; rename with wiki-links shows count prompt | FAILED | CR-01 unfixed: `RenameResult` at line 279 still has no `#[serde(rename_all = "camelCase")]`. CR-02 unfixed: Sidebar.svelte line 213 still passes `{onPathChanged}` shorthand (undefined) instead of `onPathChanged={handlePathChanged}`. |
| 3 | User can open multiple files in tabs; Cmd/Ctrl+Tab cycles; split view for side-by-side editing | VERIFIED (regression check passed) | `tabStore.ts` exports `openTab`, `closeTab`, `cycleTab`, `moveToPane`. `EditorPane.svelte` uses `Map`-based EditorView lifecycle. `VaultLayout.svelte` has global keyboard handlers. |
| 4 | External edit merges cleanly with "Externe Änderungen wurden eingebunden" toast; conflict keeps local with "Konflikt in <file> – lokale Version behalten" toast | FAILED | EditorPane.svelte lines 271 and 278 still use English strings: "External changes merged into ${filename}." and "Conflict in ${filename} — local version kept." |
| 5 | App's own writes never trigger external-change toasts; bulk external changes (>500 files) show progress UI | VERIFIED (regression check passed) | All file commands call `record_write()`. `BULK_THRESHOLD = 500` in watcher.rs. Sidebar subscribes to `listenBulkChangeStart`/`listenBulkChangeEnd`. |
| 6 | Vault unmount disables editing with toast; disk-full write shows toast without losing buffer | VERIFIED (regression check passed) | `listenVaultStatus` wired in EditorPane; `vaultReachable` state drives readonly overlay; "Vault unavailable. Editing disabled." / "Vault reconnected. Editing re-enabled." toasts present. |

**Score:** 4/6 truths verified

### Required Artifacts (Failed Items — Full Check)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/commands/files.rs` | RenameResult with camelCase serde | STUB (serde bug) | Line 278-283: `#[derive(serde::Serialize)]` present but no `#[serde(rename_all = "camelCase")]`. Serializes as `{new_path, link_count}` not `{newPath, linkCount}`. |
| `src/components/Sidebar/Sidebar.svelte` | onPathChanged wired to handlePathChanged | NOT_WIRED | Line 213: `{onPathChanged}` shorthand. `onPathChanged` is not in scope — function is `handlePathChanged` (line 156). |
| `src/components/Editor/EditorPane.svelte` | German toast messages | WRONG_VALUE | Lines 271 and 278: English "External changes merged into..." and "Conflict in..." instead of required German strings. |

### Key Link Verification (Failed Items)

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `Sidebar.svelte` | `handlePathChanged` (onPathChanged prop) | path change propagation to TreeNode | NOT_WIRED | `{onPathChanged}` passes undefined; `handlePathChanged` never reaches TreeNode |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| FILE-01 | Sidebar lazy-loaded tree | SATISFIED | list_directory + TreeNode lazy-expand; dot-dirs hidden |
| FILE-02 | User can create new file | SATISFIED | create_file command + Sidebar New file button + InlineRename |
| FILE-03 | User can rename files | FUNCTIONALLY BROKEN | rename_file command works on disk; serde mismatch (CR-01) means frontend reads undefined newPath/linkCount; wiki-link count prompt never fires; onPathChanged (CR-02) means tree never updates after rename |
| FILE-04 | Delete moves to .trash/ | SATISFIED | delete_file moves to .trash/ with auto-suffix collision |
| FILE-05 | User can move files by drag-and-drop | SATISFIED | move_file + TreeNode drag-drop with text/vaultcore-file MIME |
| FILE-08 | Symbolic links displayed but not followed | SATISFIED | symlink_metadata() detection; "(link)" indicator in TreeNode |
| FILE-09 | Non-UTF-8 files displayed; opening shows toast | SATISFIED | list_directory returns all files; TreeNode shows toast on non-md click |
| EDIT-05 | Multi-tab with Cmd/Ctrl+Tab cycling | SATISFIED | tabStore + TabBar/Tab; global keyboard handler in VaultLayout |
| EDIT-06 | Split-view: two notes side-by-side | SATISFIED | SplitState in tabStore; EditorPane per pane; drag-to-split |
| SYNC-01 | File watcher detects external changes | SATISFIED | notify-debouncer-full spawned in open_vault |
| SYNC-02 | Write-ignore-list suppresses own writes | SATISFIED | All 6 file-op commands call record_write() before mutation |
| SYNC-03 | Bulk changes debounced over 200ms | SATISFIED | DEBOUNCE_DURATION = 200ms in watcher.rs |
| SYNC-04 | Batch parsing parallelized with rayon | PARTIAL | rayon crate present; sequential processing in Phase 2 per plan decision; batch parallelism is Phase 3 concern |
| SYNC-05 | >500 file batch triggers progress UI | SATISFIED | BULK_THRESHOLD = 500; Sidebar shows "Scanning changes..." strip |
| SYNC-06 | Three-way merge for external changes | SATISFIED (wrong language) | Merge logic fully wired; toast messages in wrong language |
| SYNC-07 | Conflict: local editor state wins | SATISFIED | MergeOutcome::Conflict(left) keeps local |
| SYNC-08 | Clean merge / conflict toasts | FAILED | Toast text is English not German per ROADMAP SC#4 |
| IDX-07 | .obsidian/ hidden by file browser | SATISFIED | Dot-prefix filter in list_directory_impl and is_hidden_path in watcher |
| ERR-03 | Vault unreachable: editing disabled, toast | SATISFIED | Watcher error -> vault://vault_status {reachable:false} -> EditorPane overlay + toast |
| ERR-04 | Disk-full: toast without losing buffer | SATISFIED | Auto-save error handler checks DiskFull kind, debounces toast, keeps tab dirty |

### Anti-Patterns Found (Active)

| File | Line | Pattern | Severity | Status |
|------|------|---------|----------|--------|
| `src-tauri/src/commands/files.rs` | 279 | RenameResult missing #[serde(rename_all = "camelCase")] | Blocker | UNFIXED |
| `src/components/Sidebar/Sidebar.svelte` | 213 | {onPathChanged} shorthand passes undefined to TreeNode | Blocker | UNFIXED |
| `src/components/Editor/EditorPane.svelte` | 271, 278 | English toast messages instead of required German | Blocker | UNFIXED |
| `src/components/Editor/EditorPane.svelte` | 203 | Non-disk-full auto-save errors show "Disk full." message | Warning | UNFIXED |
| `src/components/Sidebar/TreeNode.svelte` | 308 | {isNewEntry} passed to InlineRename which expects isNewFile | Warning | UNFIXED |
| `src/store/tabStore.ts` | 278-283 | closeByPath has no-op _store.update() returning state unchanged | Info | UNFIXED |

### Human Verification Required

### 1. Sidebar Tree Navigation

**Test:** Run `pnpm tauri dev`, open a vault with subfolders. Verify: folders listed before files, alphabetical sort, .obsidian/.git/.trash absent. Click a folder to expand. Verify lazy-load (only one level).
**Expected:** Correct folder-first sort, dot-dirs absent, subtrees load only on expand.
**Why human:** Requires running Tauri dev build and real filesystem.

### 2. File Operations (Partial — Rename is Broken)

**Test:** Create a file via New file button — verify inline rename input appears. Delete a file via context menu — verify confirmation dialog appears and file moves to .trash/. Drag a file to another folder — verify it moves.
**Expected:** Create, delete-to-trash, and drag-drop-move work. Note: rename will appear to work on disk but the wiki-link count prompt will never appear (always 0 due to CR-01), and the sidebar tree will not update after rename due to CR-01 and CR-02 gaps.
**Why human:** UI interaction requires Tauri window.

### 3. Multi-Tab and Split View

**Test:** Click 3+ files in sidebar to open tabs. Press Cmd/Ctrl+Tab to cycle. Drag a tab to the right edge of the editor area.
**Expected:** Tabs open and cycle correctly. Drag to edge creates 2-pane split. Each pane edits independently.
**Why human:** Tab drag and split detection requires runtime UI interaction.

### 4. External Edit Merge (Toast Language Check)

**Test:** Open a file in VaultCore. In a terminal, append a line to the same file (`echo "external" >> file.md`). Wait for the watcher to fire.
**Expected:** Toast appears. Note: current implementation shows English "External changes merged into..." — ROADMAP requires German "Externe Änderungen wurden eingebunden". This is a known gap.
**Why human:** Requires external editor and timing coordination.

### 5. Self-Write Non-Triggering

**Test:** Edit a file in VaultCore, wait 2s for auto-save. Verify no external-change toast appears.
**Expected:** Auto-save writes are silently filtered by write-ignore-list.
**Why human:** Cannot verify absence of toast without running the app.

### 6. Vault Unmount Handling

**Test:** With VaultCore open and a file in an editor, rename the vault folder to a different name in another terminal.
**Expected:** Editors show readonly overlay, toast "Vault unavailable. Editing disabled." appears.
**Why human:** Requires live filesystem manipulation and observation of app state.

### Gaps Summary

Three programmatic gaps remain unfixed from the prior verification cycle.

**Gap 1 (Blocker, UNFIXED): Serde field name mismatch in RenameResult (CR-01)**
`src-tauri/src/commands/files.rs` line 279 — `RenameResult` derives `serde::Serialize` without `#[serde(rename_all = "camelCase")]`. Rust serializes `new_path`/`link_count` (snake_case); TypeScript reads `result.newPath`/`result.linkCount` (camelCase). Both are always `undefined`. Wiki-link count confirmation prompt never fires; new file path never propagates after rename; ROADMAP SC#2 not met.

Fix: Add `#[serde(rename_all = "camelCase")]` to the `RenameResult` derive on line 278.

**Gap 2 (Blocker, UNFIXED): Undefined onPathChanged prop in Sidebar (CR-02)**
`src/components/Sidebar/Sidebar.svelte` line 213 — Template passes `{onPathChanged}` shorthand. No `onPathChanged` variable exists in scope; the function is named `handlePathChanged` (line 156). Every TreeNode receives `undefined` for `onPathChanged`. When rename or path-change calls `onPathChanged(oldPath, newPath)` in TreeNode, it silently does nothing. Sidebar tree stays stale after rename.

Fix: Change `{onPathChanged}` to `onPathChanged={handlePathChanged}` on line 213.

**Gap 3 (Blocker, UNFIXED): German toast text required by ROADMAP SC#4**
`src/components/Editor/EditorPane.svelte` lines 271 and 278 — ROADMAP Success Criterion #4 specifies exact German toast strings. CONTEXT.md explicitly says "hardcode German for now." Current implementation uses English. The merge logic itself is correct and fully wired.

Fix: Line 271: change to `` `Externe Änderungen wurden in ${filename} eingebunden.` ``; Line 278: change to `` `Konflikt in ${filename} – lokale Version behalten.` ``

---

_Verified: 2026-04-12T13:00:00Z_
_Verifier: Claude (gsd-verifier)_
