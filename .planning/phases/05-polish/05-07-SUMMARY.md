---
phase: 05-polish
plan: "07"
subsystem: file-browser
tags: [FILE-06, FILE-07, UI-06, persistence, sort, expand, audit]
dependency_graph:
  requires: [05-00, 05-04]
  provides: [treeState-persistence, sort-menu, expand-persistence, ui06-regression-guard]
  affects: [Sidebar.svelte, TreeNode.svelte]
tech_stack:
  added: []
  patterns:
    - "Per-vault localStorage key via SHA-256 truncated to 16 hex chars (vaultcore-tree-state:{hash})"
    - "sortEntries: folders-first, null timestamps sort last"
    - "onExpandToggle callback prop propagated from Sidebar → TreeNode for FILE-07"
    - "TDD: RED (failing test) → GREEN (implementation) → commit"
    - "UI-06 grep-based regression guard in vitest using node:fs walk"
key_files:
  created:
    - src/lib/treeState.ts
    - src/components/Sidebar/SortMenu.svelte
    - src/lib/__tests__/treeState.test.ts
    - src/lib/__tests__/ui06Audit.test.ts
  modified:
    - src/components/Sidebar/Sidebar.svelte
    - src/components/Sidebar/TreeNode.svelte
decisions:
  - "DirEntry uses snake_case (is_dir, is_md) not camelCase — treeState.ts adapted to match existing frontend type"
  - "onMount auto-load: TreeNode loads children on mount when initiallyExpanded=true (FILE-07 restore)"
  - "Recursive svelte:self passes initiallyExpanded=false for child nodes (only root-level nodes get restored expand state from Sidebar)"
  - "localStorage vi.stubGlobal pattern reused from themeStore/settingsStore tests"
metrics:
  duration: "6 minutes"
  completed: "2026-04-13"
  tasks: 3
  files: 6
requirements: [FILE-06, FILE-07, UI-06]
---

# Phase 5 Plan 07: File Browser Sort + Expand Persistence + UI-06 Audit Summary

Per-vault sort order and folder expand/collapse state persist across vault re-opens via localStorage keyed by SHA-256(vault_path) truncated to 16 hex chars; UI-06 regression guard locks in the toast/dialog-only error surface.

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create treeState.ts + tests (TDD) | c7009e9 | src/lib/treeState.ts, src/lib/__tests__/treeState.test.ts |
| 2 | SortMenu + Sidebar + TreeNode wiring | c080a77 | src/components/Sidebar/SortMenu.svelte, Sidebar.svelte, TreeNode.svelte |
| 3 | UI-06 audit regression test | 6f62b33 | src/lib/__tests__/ui06Audit.test.ts |

## What Was Built

### Task 1: treeState.ts (FILE-06, FILE-07)

`src/lib/treeState.ts` exports:
- `SortBy` type: `"name" | "modified" | "created"`
- `TreeState` interface: `{ sortBy, expanded: string[] }`
- `DEFAULT_TREE_STATE`: `{ sortBy: "name", expanded: [] }`
- `vaultHashKey(path)`: SHA-256 digest → `vaultcore-tree-state:{first 16 hex chars}`
- `loadTreeState(vaultPath)`: reads + validates localStorage; soft-fails on corrupt JSON
- `saveTreeState(vaultPath, state)`: serializes to localStorage
- `sortEntries(entries, sortBy)`: folders-first (always alpha), then files by chosen order; null timestamps sort last

7 unit tests cover: name-sort folders-first, modified-desc, created-desc with nulls-last, deterministic hash key, round-trip save/load, default for unknown vault, default on corrupted JSON.

### Task 2: SortMenu + Sidebar + TreeNode wiring

**SortMenu.svelte**: popover `role="menu"` with 3 `role="menuitemradio"` options (Name / Geändert / Erstellt); active option shows lucide `Check` + `--color-accent-bg` background; Escape key dismisses.

**Sidebar.svelte**:
- Imports `ArrowUpDown` from lucide-svelte + `SortMenu` component + treeState functions
- `treeState` and `sortMenuOpen` state added
- `loadTreeState` called on mount before `loadRoot()` so sort + expanded are applied from first render
- `loadRoot` now applies `sortEntries` to raw `listDirectory` results
- `handleSortSelect`: updates sort, persists, re-sorts rootEntries client-side
- `onExpandToggle(relPath, isExpanded)`: maintains `treeState.expanded` Set, persists via `saveTreeState`
- `vaultRel(absPath)`: strips vault path prefix for portable relative paths in expanded[]
- ArrowUpDown button + SortMenu rendered in sidebar header actions area
- Root TreeNodes receive `onExpandToggle`, `initiallyExpanded`, `sortBy` props

**TreeNode.svelte**:
- New props: `onExpandToggle?`, `initiallyExpanded?` (default false), `sortBy?` (default "name")
- `expanded` initializes from `initiallyExpanded`
- `onMount`: auto-loads children when `initiallyExpanded=true` and `is_dir`
- `toggleExpand`: calls `onExpandToggle?.()` after state flip
- `loadChildren`: applies `sortEntries` to child entries
- `svelte:self` recursive render passes `onExpandToggle` and `sortBy` down

### Task 3: UI-06 audit (D-21)

`src/lib/__tests__/ui06Audit.test.ts` — regression guard:
- **Test 1**: Walks `src/**/*.{ts,tsx,svelte}` (excluding `__tests__`, `dist`); strips comments; asserts zero matches for `window.alert(`, `window.confirm(`, bare `alert(`, bare `confirm(` — 0 offenders found
- **Test 2**: Finds all `toastStore.push(...)` callsites; asserts each has both `variant:` and `message:` keys — 0 violations found

## Test Results

```
Test Files  19 passed (19)
Tests       116 passed (116)
```

- `src/lib/__tests__/treeState.test.ts` — 7 tests green (FILE-06 sort, FILE-07 persistence)
- `src/lib/__tests__/ui06Audit.test.ts` — 2 tests green (UI-06 regression guard)
- Full suite: 116 tests, 0 failures

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] DirEntry uses snake_case, not camelCase**
- **Found during:** Task 1 implementation
- **Issue:** Plan showed `isDir`, `isMd`, `isSymlink` in the plan's interface snippet, but existing `src/types/tree.ts` uses `is_dir`, `is_md`, `is_symlink` (snake_case preserved for IPC backward compat per D-20 Phase 02 decision)
- **Fix:** `sortEntries` uses `e.is_dir` instead of `e.isDir`; test helper `entry()` creates `{ is_dir, is_symlink, is_md }` fields
- **Files modified:** src/lib/treeState.ts, src/lib/__tests__/treeState.test.ts
- **Commit:** c7009e9

**2. [Rule 2 - Auto-add] localStorage stub required for treeState tests**
- **Found during:** Task 1 test setup
- **Issue:** Vitest jsdom environment removes standard `localStorage` interface per Phase 5 decision log entry — must use `vi.stubGlobal` pattern
- **Fix:** Added `makeLocalStorage()` factory + `vi.stubGlobal("localStorage", ...)` in `beforeEach` — same pattern as `themeStore.test.ts` and `settingsStore.test.ts`
- **Files modified:** src/lib/__tests__/treeState.test.ts
- **Commit:** c7009e9

**3. [Rule 3 - Blocking] onMount import must be at top of script block**
- **Found during:** Task 2 TreeNode editing
- **Issue:** Initial edit accidentally placed `import { onMount } from "svelte"` mid-script after the derived declaration — Svelte/TS would reject this
- **Fix:** Moved import to top of script block alongside other imports; removed duplicate mid-block import
- **Files modified:** src/components/Sidebar/TreeNode.svelte
- **Commit:** c080a77

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns introduced. `vaultHashKey` uses Web Crypto `crypto.subtle.digest` (available in Tauri webview, no network). All threat mitigations from the plan's threat register are implemented:

| Threat | Mitigation | Status |
|--------|-----------|--------|
| T-05-07-01: Tampered localStorage sortBy | `loadTreeState` validates against `VALID_SORT_BY` whitelist + isArray guard | Implemented |
| T-05-07-04: Inline alert/confirm | `ui06Audit.test.ts` fails CI on any new inline alert/confirm | Implemented |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/lib/treeState.ts | FOUND |
| src/components/Sidebar/SortMenu.svelte | FOUND |
| src/lib/__tests__/treeState.test.ts | FOUND |
| src/lib/__tests__/ui06Audit.test.ts | FOUND |
| Commit c7009e9 (Task 1) | FOUND |
| Commit c080a77 (Task 2) | FOUND |
| Commit 6f62b33 (Task 3) | FOUND |
