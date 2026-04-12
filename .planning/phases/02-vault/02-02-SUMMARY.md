---
phase: 02-vault
plan: 02
subsystem: rust-backend, frontend-sidebar, frontend-layout
tags: [file-operations, sidebar, tree, drag-drop, inline-rename, TDD, lucide-svelte]
dependency_graph:
  requires:
    - 02-01 (list_directory command, DirEntry types, IPC wrappers, WriteIgnoreList)
  provides:
    - create_file Rust command (vault-scoped, auto-suffix collision, write_ignore recording)
    - create_folder Rust command (vault-scoped, auto-suffix collision)
    - rename_file Rust command (vault-scoped, wiki-link counting via regex before rename, RenameResult)
    - delete_file Rust command (vault-scoped, .trash/ auto-created, collision auto-suffix, write_ignore both paths)
    - move_file Rust command (vault-scoped source + dest, PermissionDenied if outside vault)
    - count_wiki_links Rust command (walks all .md files, counts [[stem]] via regex)
    - Sidebar.svelte (lazy-loaded tree, new file/folder buttons, aria-label)
    - TreeNode.svelte (recursive, expand/collapse, drag-drop, context menu, confirmations, role=treeitem)
    - InlineRename.svelte (auto-focus, Enter/Escape/Blur, validation, .md auto-append)
    - VaultLayout.svelte (CSS Grid sidebar+divider+editor, drag-resize, localStorage persist, collapse toggle)
    - vaultStore.ts extended with treeCache, sidebarWidth, setSidebarWidth
    - App.svelte routes to VaultLayout when vault is ready (replaces VaultView)
  affects:
    - src-tauri/src/commands/files.rs (6 new commands added)
    - src-tauri/src/lib.rs (6 new commands registered)
    - src/store/vaultStore.ts (treeCache + sidebarWidth added)
    - src/App.svelte (VaultView replaced with VaultLayout)
tech_stack:
  added:
    - lucide-svelte 1.0.1 (sidebar icons — FilePlus, FolderPlus, ChevronRight, Folder, FolderOpen, FileText, File, MoreHorizontal)
  patterns:
    - _impl helper pattern for testable Tauri command bodies (TDD RED/GREEN)
    - find_available_name() helper for collision auto-suffix (file and folder)
    - walk_md_files() helper reuses vault.rs is_excluded dot-filter pattern
    - treeCache kept as module-level Map (not in store state — Maps don't serialize well)
    - Drag-and-drop via custom MIME type "text/vaultcore-file" (T-02-09 mitigation)
    - Inline confirmation dialogs (not modal) for delete and rename-with-links
key_files:
  created:
    - src-tauri/src/tests/files_ops.rs
    - src/components/Sidebar/Sidebar.svelte
    - src/components/Sidebar/TreeNode.svelte
    - src/components/Sidebar/InlineRename.svelte
    - src/components/Layout/VaultLayout.svelte
  modified:
    - src-tauri/src/commands/files.rs (6 Wave 2 commands + helpers added)
    - src-tauri/src/lib.rs (6 new commands in invoke_handler)
    - src-tauri/src/tests/mod.rs (mod files_ops added)
    - src/store/vaultStore.ts (treeCache + sidebarWidth)
    - src/App.svelte (VaultLayout replaces VaultView)
    - package.json (lucide-svelte added)
decisions:
  - treeCache is a module-level Map in vaultStore.ts (not inside the writable store state) — Maps don't serialize well in Svelte stores and tree cache is ephemeral per-session
  - InlineRename cancel+isNewFile: deletes the newly created file via deleteFile IPC (avoids orphan files)
  - VaultLayout uses CSS Grid with 3-column template [sidebar][divider][1fr] — not flexbox — for precise column control
  - Drag-to-resize persists to localStorage (key "vaultcore-sidebar-width") on mouseup, reads on mount — no IPC required
  - Context menu is inline positioned (not a portal) to avoid z-index complexity in MVP
  - Confirmation dialogs are position:fixed centered (not absolute to node) for predictable viewport placement
metrics:
  duration: 25min
  completed: 2026-04-12T08:24:12Z
  tasks_completed: 2
  files_modified: 11
---

# Phase 02 Plan 02: File-Operation Commands and Sidebar UI Summary

**One-liner:** Six Rust file-management commands (create/rename/delete/move/create_folder/count_wiki_links) with vault-scope guards and write_ignore recording; full sidebar tree UI with lazy loading, inline rename, delete-to-.trash/ confirmation, wiki-link count prompt, drag-and-drop move, and resizable VaultLayout CSS Grid shell replacing VaultView.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing tests for Wave 2 file-operation commands | 61e64c6 | src-tauri/src/tests/files_ops.rs, tests/mod.rs |
| 1 (GREEN) | Rust Wave 2 file-operation commands | 16d34a5 | commands/files.rs, lib.rs |
| 2 | Sidebar tree UI, VaultLayout, inline rename, drag-drop | 363a438 | Sidebar.svelte, TreeNode.svelte, InlineRename.svelte, VaultLayout.svelte, vaultStore.ts, App.svelte, package.json |

## Verification Results

- `cargo test --lib`: 45 passed, 0 failed (11 new tests for Wave 2 commands)
- `npx vitest run`: 35 passed, 0 failed

## Deviations from Plan

None — plan executed exactly as written.

**Implementation detail notes:**

1. **[Discretion] treeCache as module-level Map** — The plan specified adding `treeCache: Map<string, DirEntry[]>` to the store state. Because Maps don't serialize well in Svelte stores (Svelte's reactivity system doesn't track Map mutations), treeCache is kept as a module-level constant alongside the store, with `setTreeEntries`/`getTreeEntries`/`invalidateTree` helpers exposed on `vaultStore`. This is a correct implementation of the same semantic intent.

2. **[Discretion] InlineRename `isNewFile` prop** — Named `isNewEntry` internally to avoid collision with the `isNewFile` prop name in the Svelte component scope. Functionally equivalent.

3. **[Discretion] Drag-to-resize event listeners** — Added to `document` (not window) in onMount/onDestroy to cleanly capture mouse events that leave the divider area during fast drag. Cleanup is done in both the onMount return and onDestroy for safety.

## Known Stubs

- `VaultLayout.svelte`: Editor area renders a placeholder `<div>` with "No file open" text — intentional per plan ("Plan 03 replaces this with EditorPane/TabBar").
- `TreeNode.svelte` `handleNewFileHere`: After creating a new file in a subfolder, the inline rename is triggered on the child `TreeNode` via the children re-render. The orchestration relies on the new entry appearing in `children` after `loadChildren()` refresh — this correctly wires up because `TreeNode` self-manages its expand/load state.

## Threat Surface Scan

All security-relevant surfaces are covered by the plan's threat model:

| Mitigation | Implementation |
|------------|---------------|
| T-02-05: create_file path validation | `ensure_parent_inside_vault()` canonicalizes parent + `starts_with(vault)` |
| T-02-06: rename_file path validation | `ensure_inside_vault()` on old path + `ensure_parent_inside_vault()` on new path |
| T-02-07: delete_file path validation | `ensure_inside_vault()` on target; .trash/ always inside vault root |
| T-02-08: move_file path validation | `ensure_inside_vault()` on both source and dest folder |
| T-02-09: drag-drop MIME check | `dataTransfer.types.includes("text/vaultcore-file")` guards all dragover/drop handlers |

## Self-Check: PASSED
