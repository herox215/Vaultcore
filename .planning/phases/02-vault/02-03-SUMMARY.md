---
phase: 02-vault
plan: 03
subsystem: frontend-tabs, frontend-editor, frontend-layout
tags: [multi-tab, split-view, tabStore, EditorPane, TabBar, TDD, drag-drop, keyboard-shortcuts]
dependency_graph:
  requires:
    - 02-02 (VaultLayout.svelte, Sidebar.svelte, VaultLayout CSS Grid shell)
    - 02-01 (readFile/writeFile IPC wrappers, editorStore)
  provides:
    - tabStore (openTab, closeTab, activateTab, cycleTab, moveToPane, setDirty, updateScrollPos, updateFilePath, closeByPath)
    - SplitState tracking (left/right pane tab ID arrays, activePane)
    - Tab.svelte (active indicator, dirty dot, close button, drag-to-reorder)
    - TabBar.svelte (scrollable tab strip, drag-to-reorder drop zone)
    - EditorPane.svelte (Map-based EditorView lifecycle, display:none/block switching, drag-to-split)
    - VaultLayout.svelte extended with EditorPane wiring, split divider, global keyboard shortcuts
    - CMEditor.svelte extended with readonly prop via Compartment
    - editorStore.syncFromTab() for tab-switch content sync
  affects:
    - src/store/tabStore.ts (new file)
    - src/store/editorStore.ts (syncFromTab added)
    - src/components/Tabs/Tab.svelte (new file)
    - src/components/Tabs/TabBar.svelte (new file)
    - src/components/Editor/EditorPane.svelte (new file)
    - src/components/Editor/CMEditor.svelte (readonly prop + Compartment)
    - src/components/Layout/VaultLayout.svelte (EditorPane wired, split divider, keyboard shortcuts)
tech_stack:
  added: []
  patterns:
    - Map<tabId, EditorView> module-level variable for undo-history-preserving tab switching (Pitfall 4 mitigation)
    - display:none/block CSS toggle to show/hide EditorView container divs without destroying CM6 instances
    - Compartment for reactive readonly state in CM6 (reconfigure dispatch on prop change)
    - text/vaultcore-tab custom MIME type for drag-drop (T-02-11 mitigation)
    - _reorderPane() store helper for drag-to-reorder without exposing internal writable
    - Global keydown handler on svelte:document for Cmd/Ctrl+Tab/+W (not per-TabBar to avoid duplicate)
key_files:
  created:
    - src/store/tabStore.ts
    - src/store/tabStore.test.ts
    - src/components/Tabs/Tab.svelte
    - src/components/Tabs/TabBar.svelte
    - src/components/Editor/EditorPane.svelte
  modified:
    - src/store/editorStore.ts (syncFromTab added)
    - src/components/Editor/CMEditor.svelte (readonly prop + Compartment)
    - src/components/Layout/VaultLayout.svelte (EditorPane wired, split divider, keyboard shortcuts)
decisions:
  - tabStore uses Map-based EditorView lifecycle (not {#key} remount) to preserve full undo history across tab switches — UI-SPEC note about {#key} remount was a simplification; PLAN.md's Map strategy is correct
  - EditorPane manages EditorView lifecycle directly (not via CMEditor) — CMEditor is now a standalone widget for single-file use; EditorPane creates EditorView instances in JS and appends their DOM containers
  - vaultReachable placeholder always returns true in Plan 03 — Plan 05 wires the actual watcher-based trigger (ERR-03)
  - _reorderPane() added to tabStore to support drag-to-reorder without exposing the internal writable store
  - Compartment used for CM6 readonly prop so the extension can be reconfigured reactively without full EditorView remount
metrics:
  duration: 6min
  completed: 2026-04-12T08:38:46Z
  tasks_completed: 2
  files_modified: 8
---

# Phase 02 Plan 03: Multi-Tab Editing and Split-View Summary

**One-liner:** tabStore with split-pane state management; Tab/TabBar/EditorPane Svelte components using Map-based EditorView lifecycle to preserve undo history; drag-to-reorder, drag-to-split, middle-click close, Cmd/Ctrl+Tab/+W keyboard shortcuts, and 2-pane horizontal split view wired into VaultLayout.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing tabStore tests | 5bcf609 | src/store/tabStore.test.ts |
| 1 (GREEN) | tabStore implementation + editorStore.syncFromTab | a296894 | src/store/tabStore.ts, src/store/editorStore.ts |
| 2 | Tab, TabBar, EditorPane, CMEditor, VaultLayout | ce0b693 | Tab.svelte, TabBar.svelte, EditorPane.svelte, CMEditor.svelte, VaultLayout.svelte, tabStore.ts (_reorderPane) |
| — | pnpm-lock.yaml cleanup | c1df716 | pnpm-lock.yaml |

## Verification Results

- `npx vitest run`: 56 passed, 0 failed (21 new tabStore tests + 35 prior)
- `npx vitest run src/store/tabStore.test.ts`: 21 passed, 0 failed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] moveToPane collapse logic had incorrect left pane assignment**
- **Found during:** TDD GREEN (tabStore test run)
- **Issue:** When moving a tab from right pane back to left and right became empty, the collapse logic used `newSourceIds` (empty) as the left pane instead of `newTargetIds` (the tab being moved)
- **Fix:** Corrected `moveToPane` to always use `newTargetIds` as the left pane when collapsing
- **Files modified:** src/store/tabStore.ts
- **Commit:** a296894 (fix applied before final GREEN commit)

**2. [Rule 2 - Missing] _reorderPane() not in plan but required by TabBar**
- **Found during:** Task 2 implementation
- **Issue:** TabBar.svelte needs to reorder tab IDs in the store after drag-to-reorder drop, but tabStore had no method for this
- **Fix:** Added `_reorderPane(pane, newIds)` method to tabStore
- **Files modified:** src/store/tabStore.ts
- **Commit:** ce0b693

**3. [Discretion] CMEditor remains functional for single-file use**
- The plan suggested CMEditor could become a factory function or be simplified. EditorPane directly creates and manages EditorView DOM nodes, making CMEditor still usable as a standalone widget for single-file contexts (not used in EditorPane but kept for backward compatibility). The plan allowed this discretion.

## Known Stubs

- `EditorPane.svelte` line 34: `vaultReachable = $state(true)` — the vault reachability flag is hardcoded to `true`. ERR-03 readonly overlay is fully implemented (CSS, render logic) but the trigger is not wired yet. Plan 05 wires the actual `vaultStore` flag and watcher-based detection. The overlay div renders correctly when `vaultReachable` is false.

## Threat Surface Scan

All security-relevant surfaces are covered by the plan's threat model:

| Mitigation | Implementation |
|------------|---------------|
| T-02-11: tab drag-drop MIME check | `e.dataTransfer.types.includes("text/vaultcore-tab")` guards all dragover/drop handlers in EditorPane and TabBar |
| T-02-12: EditorView Map holds file content in memory | Accepted — user has local filesystem access; no network exposure |
| T-02-13: no hard tab limit | Accepted — browser memory is natural limit for MVP |

## Self-Check: PASSED
