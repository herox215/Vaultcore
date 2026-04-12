---
type: quick
quick_id: 260412-hsp
description: "Fix Phase 2 bugs: editor content not showing, folder collapse on tree refresh"
files_modified:
  - src/components/Editor/EditorPane.svelte
  - src/components/Sidebar/Sidebar.svelte
autonomous: true
---

<objective>
Fix 2 user-reported bugs from Phase 2:

1. **Editor content not displaying**: `createEditorView()` appends containers to `paneEl` (the outer `.vc-editor-pane` flex column), but they need to go inside `.vc-editor-content` (the inner content area). Containers appended after `.vc-editor-content` in a column flex get 0 remaining height.

2. **Folder collapses on file create/rename**: `loadRoot()` sets `loading = true`, which causes the template `{#if loading}` branch to render, destroying all TreeNode components and their local `expanded` state. When loading completes, the tree is rebuilt from scratch with all folders collapsed.

The "right pane always empty" report is expected behavior — the right pane only appears on drag-to-split. Once Bug 1 is fixed, the editor area won't appear blank.
</objective>

<tasks>

<task type="auto">
  <name>Task 1: Fix editor container append target and folder collapse</name>
  <files>src/components/Editor/EditorPane.svelte, src/components/Sidebar/Sidebar.svelte</files>
  <action>
**EditorPane.svelte:**
- Add `contentEl` ref: `let contentEl = $state<HTMLDivElement | undefined>();`
- Bind it to `.vc-editor-content`: `bind:this={contentEl}`
- In `createEditorView()`, change `paneEl.appendChild(container)` to `contentEl.appendChild(container)` and guard with `if (!contentEl) return;`
- Change container styling from `width:100%; height:100%` to `position:absolute; inset:0` (since parent has `position:relative`)

**Sidebar.svelte:**
- In `loadRoot()`, only set `loading = true` when `rootEntries.length === 0` (initial load), skip for refreshes to avoid destroying the tree and losing expansion state
  </action>
  <verify>
    <automated>cd /home/sokragent/Projects/vaultcore && grep -n 'contentEl.appendChild' src/components/Editor/EditorPane.svelte && grep -n 'bind:this={contentEl}' src/components/Editor/EditorPane.svelte && grep -n 'rootEntries.length === 0' src/components/Sidebar/Sidebar.svelte</automated>
  </verify>
  <done>Editor containers append to content area; tree refresh preserves expansion state</done>
</task>

</tasks>
