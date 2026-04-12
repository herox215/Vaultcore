---
phase: 04-links
plan: "04"
subsystem: ui
tags: [svelte, typescript, codemirror6, wiki-links, backlinks, ipc, css-grid]
dependency_graph:
  requires:
    - phase: 04-links-01
      provides: link-graph-backend, link-ipc-commands (getBacklinks, updateLinksAfterRename, getResolvedLinks, createFile)
    - phase: 04-links-02
      provides: wiki-link-cm6-plugin, setResolvedLinks, resolveTarget, refreshWikiLinks, wiki-link-click CustomEvent
    - phase: 04-links-03
      provides: wiki-link-autocomplete-cm6
  provides:
    - right-sidebar-backlinks-panel
    - wiki-link-click-navigation
    - rename-cascade-confirmation
    - move-cascade-confirmation
  affects: [editor-integration, vault-layout, sidebar-tree]
tech_stack:
  added: []
  patterns:
    - backlinksStore: classic Svelte writable with localStorage persistence (same pattern as tabStore)
    - 5-column CSS grid in VaultLayout (sidebar|divider|editor|right-divider|right-sidebar)
    - wiki-link-click CustomEvent consumed in EditorPane — decouples CM6 from Svelte stores
    - reloadResolvedLinks() soft-fail pattern: empty Map on error, app stays functional
    - getVaultRoot() one-shot subscribe pattern in TreeNode for relative path computation
key_files:
  created:
    - src/store/backlinksStore.ts
    - src/components/Backlinks/BacklinkRow.svelte
    - src/components/Backlinks/BacklinksPanel.svelte
    - src/components/Layout/RightSidebar.svelte
  modified:
    - src/components/Layout/VaultLayout.svelte
    - src/components/Editor/EditorPane.svelte
    - src/components/Sidebar/TreeNode.svelte
key_decisions:
  - "backlinksStore uses classic writable store (D-06/RC-01) — no $state class wrappers"
  - "VaultLayout 5-column grid: sidebar|auto|1fr|auto|right-sidebar-width; right sidebar hidden via 0px CSS var when closed"
  - "EditorPane attaches wiki-link-click listener per EditorView DOM at mount time — one listener per view, not one global"
  - "reloadResolvedLinks soft-fail: getResolvedLinks error sets empty Map so app stays functional with grey links"
  - "TreeNode getVaultRoot() one-shot subscribe avoids coupling TreeNode to vaultStore reactively"
  - "Move cascade (D-11): pendingMove state mirrors pendingRename, same German dialog copy, confirmMoveWithLinks calls moveFile + updateLinksAfterRename"
  - "handleRenameConfirm is now async: fetches getBacklinks(oldRelPath) after InlineRename to get unique file count Y for dialog"
requirements_completed: [LINK-03, LINK-04, LINK-06, LINK-09]
duration: "6 min"
completed: "2026-04-12"
---

# Phase 4 Plan 04: UI Wiring (Backlinks Panel, Link Navigation, Rename Cascade) Summary

**Right sidebar backlinks panel (Cmd+Shift+B), subfolder-correct wiki-link click navigation via resolveTarget(), and rename/move cascade with German confirmation dialog — all 9 LINK-XX requirements now end-to-end functional.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-04-12T17:22:14Z
- **Completed:** 2026-04-12T17:28:14Z
- **Tasks:** 3 auto tasks (Task 3 is human-verify checkpoint)
- **Files modified:** 7

## Accomplishments

- Right sidebar with BacklinksPanel: Cmd/Ctrl+Shift+B toggles, state+width persists to localStorage, lists backlinks for active note with filename+context, German empty state
- Wiki-link click handler in EditorPane: resolved links open via `resolveTarget(stem)` (zero IPC, subfolder-correct), unresolved links create the note and refresh the resolution map
- Rename cascade: German confirmation "X Links in Y Dateien werden aktualisiert. Fortfahren?" [Abbrechen] [Aktualisieren], calls `updateLinksAfterRename` on confirm, partial failure toast
- Move cascade (D-11): same dialog triggered on drag-drop, moves file then updates links

## Task Commits

1. **Task 1: Backlinks store, right sidebar layout, BacklinksPanel + BacklinkRow** - `66921a6` (feat)
2. **Task 2a: EditorPane wiki-link click handler + resolvedLinks map population** - `d0476c8` (feat)
3. **Task 2b: Rename-cascade + move-cascade in TreeNode** - `9813672` (feat)

## Files Created/Modified

- `src/store/backlinksStore.ts` - Writable store: open/width/activeFilePath/backlinks/loading, localStorage persistence, async setActiveFile calls getBacklinks IPC
- `src/components/Backlinks/BacklinkRow.svelte` - Single backlink entry: filename 14px/600, 2-line context with -webkit-line-clamp, hover accent background
- `src/components/Backlinks/BacklinksPanel.svelte` - Panel with header ("Backlinks" 12px muted), X close button, German empty state, scrollable backlink list
- `src/components/Layout/RightSidebar.svelte` - Shell wrapping BacklinksPanel
- `src/components/Layout/VaultLayout.svelte` - Extended to 5-column grid, right divider drag-to-resize, Cmd+Shift+B shortcut, tabStore subscription for active file backlinks
- `src/components/Editor/EditorPane.svelte` - Added wiki-link-click listener per EditorView, reloadResolvedLinks on vault open, handleWikiLinkClick routing
- `src/components/Sidebar/TreeNode.svelte` - Rename/move cascade with German dialog, updateLinksAfterRename, partial failure toast

## Decisions Made

- backlinksStore uses classic writable store (D-06/RC-01) — consistent with tabStore/vaultStore pattern
- VaultLayout 5-column CSS grid: `var(--sidebar-width) auto 1fr auto var(--right-sidebar-width, 0px)` — right sidebar hidden by setting CSS var to 0px, avoids DOM conditional rendering complexity
- EditorPane attaches `wiki-link-click` listener to each EditorView DOM at mount — one listener per view handles multi-tab pane
- reloadResolvedLinks soft-fail: sets empty Map on error so all links render as unresolved (grey) rather than crashing
- getVaultRoot() one-shot subscribe in TreeNode avoids reactive vaultStore coupling in a component that already receives its data via props
- Move cascade uses pendingMove state (mirrors pendingRename) — same German dialog copy, same button labels

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] handleRenameConfirm made async for getBacklinks call**
- **Found during:** Task 2b
- **Issue:** Plan called for showing unique source-file count Y in dialog. InlineRename already executes `renameFile` before returning, so `getBacklinks(oldRelPath)` must be called after rename using the old relative path (which still exists in the link graph until the next watcher event). The original `handleRenameConfirm` was synchronous and couldn't call the async IPC.
- **Fix:** Changed `handleRenameConfirm` to `async function`, added `await getBacklinks(oldRelPath)` to compute fileCount for dialog.
- **Files modified:** src/components/Sidebar/TreeNode.svelte
- **Commit:** 9813672

**2. [Rule 2 - Missing functionality] Added `vc-confirm-btn--accent` CSS class for Aktualisieren button**
- **Found during:** Task 2b
- **Issue:** Plan specified `border: 1px solid var(--color-accent); color: var(--color-accent); background: transparent` for the [Aktualisieren] button per UI-SPEC. The existing `vc-confirm-btn--primary` class uses filled accent background (wrong style). A new CSS class was needed.
- **Fix:** Added `.vc-confirm-btn--accent` with transparent background + accent border + `min-width: 80px`.
- **Files modified:** src/components/Sidebar/TreeNode.svelte
- **Commit:** 9813672

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing CSS class)
**Impact on plan:** Both fixes necessary for correct behavior and UI-SPEC compliance. No scope creep.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundary crossings introduced. All surfaces are local-only:

- **T-04-09 (createFile on unresolved click):** EditorPane passes filename to `createFile` IPC which applies vault-scope guard in Rust.
- **T-04-11 (localStorage):** backlinksStore reads open/width with try/catch + numeric clamping. Malicious values only affect UI state.
- **T-04-14 (resolveTarget lookup):** `resolveTarget()` returns only rel_paths from Rust-produced resolved map. Vault root prefix applied in EditorPane after lookup, not by concatenating user input.

## Known Stubs

None — all IPC commands are fully wired. The resolution map is populated on vault open and refreshed on click-to-create.

## Self-Check: PASSED

Files created:
- src/store/backlinksStore.ts: FOUND
- src/components/Backlinks/BacklinkRow.svelte: FOUND
- src/components/Backlinks/BacklinksPanel.svelte: FOUND
- src/components/Layout/RightSidebar.svelte: FOUND

Commits:
- 66921a6: FOUND (Task 1)
- d0476c8: FOUND (Task 2a)
- 9813672: FOUND (Task 2b)

TypeScript: 0 new errors (pre-existing tabStore errors out of scope, documented in 04-01-SUMMARY.md)
