---
phase: quick
plan: 260412-hsp
status: complete
date: 2026-04-12
key_files:
  modified:
    - src/components/Editor/EditorPane.svelte
    - src/components/Sidebar/Sidebar.svelte
decisions:
  - "EditorView containers must be appended to .vc-editor-content (contentEl), not .vc-editor-pane (paneEl) — containers as flex siblings of the content div get 0 height in a column layout"
  - "position:absolute;inset:0 is the correct sizing strategy for editor containers since .vc-editor-content has position:relative"
  - "Loading spinner during tree refresh destroys all TreeNode components, losing local expanded state — only show spinner on initial load when rootEntries is empty"
  - "Right pane appearing empty is by-design (split-view activates on drag-to-split) — not a bug, resolved by fixing editor content display"
---

# Quick Task 260412-hsp: Fix Phase 2 Bugs

## What Changed

### Bug 1: Editor content not displaying on tab switch
**Root cause:** `createEditorView()` appended EditorView containers to `paneEl` (the outer `.vc-editor-pane` flex column div). In a `flex-direction: column` layout, `.vc-editor-content` has `flex: 1 1 0` taking all remaining space, so containers appended after it received 0 height.

**Fix:** Added `contentEl` ref bound to `.vc-editor-content`. Changed `paneEl.appendChild(container)` to `contentEl.appendChild(container)`. Changed container styling from `width:100%; height:100%` to `position:absolute; inset:0` since parent has `position:relative`.

### Bug 2: Right pane always empty
Not a bug — the right pane only renders when `isSplit` is true (drag-to-split). The blank appearance was caused by Bug 1 making the editor content invisible.

### Bug 3: Folder collapses on file create/rename
**Root cause:** `loadRoot()` set `loading = true`, which caused the template `{#if loading}` to render "Loading..." instead of the tree, destroying all TreeNode components. When loading completed, the tree was rebuilt from scratch with all `expanded` states reset to `false`.

**Fix:** Only set `loading = true` when `rootEntries.length === 0` (initial load). Refresh operations silently update `rootEntries` without destroying the tree, preserving TreeNode instances and their local expansion state.

## Self-Check: PASSED
- [x] contentEl ref added and bound to .vc-editor-content
- [x] Containers append to contentEl with position:absolute;inset:0
- [x] loadRoot() only shows spinner on initial load
- [x] 56/56 tests pass, no regressions
