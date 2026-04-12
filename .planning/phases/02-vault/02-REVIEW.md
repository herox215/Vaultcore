---
phase: 02-vault
reviewed: 2026-04-12T12:00:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - src-tauri/src/commands/files.rs
  - src-tauri/src/commands/tree.rs
  - src-tauri/src/commands/vault.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/merge.rs
  - src-tauri/src/tests/files_ops.rs
  - src-tauri/src/tests/merge.rs
  - src-tauri/src/tests/mod.rs
  - src-tauri/src/tests/tree.rs
  - src-tauri/src/tests/watcher.rs
  - src-tauri/src/watcher.rs
  - src/components/Editor/EditorPane.svelte
  - src/components/Layout/VaultLayout.svelte
  - src/components/Sidebar/InlineRename.svelte
  - src/components/Sidebar/Sidebar.svelte
  - src/components/Sidebar/TreeNode.svelte
  - src/components/Tabs/Tab.svelte
  - src/components/Tabs/TabBar.svelte
  - src/ipc/commands.ts
  - src/store/tabStore.test.ts
  - src/store/tabStore.ts
  - src/store/vaultStore.ts
  - src/types/tree.ts
findings:
  critical: 2
  warning: 4
  info: 2
  total: 8
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-04-12T12:00:00Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

Reviewed the Rust backend (commands, watcher, merge engine, tests) and Svelte frontend (editor, sidebar, tabs, stores, IPC layer). The codebase demonstrates solid security practices (path traversal guards, vault-scope checks, self-write filtering). Two critical issues found: (1) a serde serialization mismatch between Rust return types and TypeScript expectations for `rename_file`, and (2) an undefined callback variable in the Sidebar that will crash the tree on rename/delete operations. Four warnings cover a prop name mismatch, an incorrect error message, a no-op store update, and a missing `onPathChanged` propagation to `handlePathChanged`. Two info items for minor dead code.

## Critical Issues

### CR-01: Serde field name mismatch between Rust `RenameResult` and TypeScript IPC

**File:** `src-tauri/src/commands/files.rs:278-281` and `src/ipc/commands.ts:95-97`
**Issue:** The Rust `RenameResult` struct uses snake_case fields (`new_path`, `link_count`) with `#[derive(serde::Serialize)]` but no `#[serde(rename_all = "camelCase")]`. Serde will serialize these as `{"new_path": ..., "link_count": ...}`. The TypeScript IPC layer expects `{ newPath: string; linkCount: number }` (camelCase). This means `result.newPath` and `result.linkCount` will always be `undefined` on the frontend, causing the rename workflow to silently fail -- the wiki-link warning dialog will never appear (linkCount is always falsy), and `onPathChanged` receives `undefined` instead of the new path.
**Fix:**
```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub new_path: String,
    pub link_count: u32,
}
```
Also verify `MergeCommandResult` in `vault.rs:340-345` -- its fields (`outcome`, `merged_content`) need the same treatment since the TS `MergeResult` interface uses `merged_content` (which happens to match snake_case, but `outcome` also matches). Add `#[serde(rename_all = "camelCase")]` for consistency and safety.

### CR-02: Undefined variable `onPathChanged` used in Sidebar template

**File:** `src/components/Sidebar/Sidebar.svelte:213`
**Issue:** The template uses `{onPathChanged}` (shorthand for `onPathChanged={onPathChanged}`), but no variable named `onPathChanged` exists in the Sidebar script scope. The defined function is `handlePathChanged` (line 156). In Svelte 5 runes mode, this will either fail to compile or pass `undefined` to every `TreeNode`, causing a runtime crash when any rename or path-change operation calls `onPathChanged(entry.path, newPath)` in TreeNode.svelte (lines 118, 129).
**Fix:**
```svelte
<TreeNode
  {entry}
  depth={0}
  {selectedPath}
  {onSelect}
  {onOpenFile}
  onRefreshParent={loadRoot}
  onPathChanged={handlePathChanged}
/>
```

## Warnings

### WR-01: Prop name mismatch -- TreeNode passes `isNewEntry` but InlineRename expects `isNewFile`

**File:** `src/components/Sidebar/TreeNode.svelte:308` and `src/components/Sidebar/InlineRename.svelte:10`
**Issue:** TreeNode passes `{isNewEntry}` to InlineRename, which is shorthand for `isNewEntry={isNewEntry}`. But InlineRename's Props interface defines `isNewFile?: boolean`, not `isNewEntry`. The `isNewFile` prop will always be `undefined` (defaulting to `false`), so if a rename fails on a newly created file, the cleanup logic to delete the placeholder file (InlineRename lines 67-68 and 77-78) will never execute, leaving orphan "Untitled.md" files on disk.
**Fix:** In TreeNode.svelte line 308, change:
```svelte
<InlineRename
  currentName={entry.name}
  oldPath={entry.path}
  isNewFile={isNewEntry}
  onConfirm={handleRenameConfirm}
  onCancel={handleRenameCancel}
/>
```

### WR-02: Incorrect error message for non-disk-full write failures

**File:** `src/components/Editor/EditorPane.svelte:203`
**Issue:** When `writeFile` throws an error that is NOT a disk-full error, the catch block still shows "Disk full. Could not save changes." This misleads users about the actual error. For example, a permission error or file-locked error would display the disk-full message.
**Fix:**
```typescript
} else {
  toastStore.push({ variant: "error", message: "Could not save changes." });
}
```

### WR-03: Dead no-op `_store.update()` in `closeByPath`

**File:** `src/store/tabStore.ts:278-283`
**Issue:** The `closeByPath` method starts with a `_store.update()` call that finds a matching tab but then returns the state unchanged (line 282: `return state;`). This triggers a spurious store notification to all subscribers for no effect. The actual work is done by the subscribe-then-closeTab pattern below it. While not a crash bug, it causes unnecessary re-renders on every `closeByPath` call and the comment "Reuse closeTab logic via internal state mutation" is misleading since no mutation occurs.
**Fix:** Remove the no-op update block entirely:
```typescript
closeByPath(filePath: string): void {
    let tabId: string | undefined;
    const unsub = _store.subscribe((state) => {
      tabId = state.tabs.find((t) => t.filePath === filePath)?.id;
    });
    unsub();
    if (tabId) {
      tabStore.closeTab(tabId);
    }
  },
```

### WR-04: Wiki-link count cast from `usize` to `u32` can silently truncate

**File:** `src-tauri/src/commands/files.rs:317`
**Issue:** `re.find_iter(&contents).count() as u32` casts a `usize` (which is 64-bit on 64-bit platforms) to `u32`. While extremely unlikely in practice (would need > 4 billion link matches in a single file), the `as` cast silently wraps on overflow in Rust. For a 100k+ note vault, this is a correctness concern worth a safe conversion.
**Fix:**
```rust
link_count += u32::try_from(re.find_iter(&contents).count()).unwrap_or(u32::MAX);
```

## Info

### IN-01: Unused `initial` constant in tabStore

**File:** `src/store/tabStore.ts:29-33`
**Issue:** The `initial` constant is defined but never used. The store is initialized via `makeInitial()` function (line 43) and `_reset()` also uses `makeInitial()`. The `initial` constant is dead code.
**Fix:** Remove the unused `initial` constant (lines 29-33).

### IN-02: Comment references "isNewFile=true" but the mechanism is incomplete

**File:** `src/components/Sidebar/TreeNode.svelte:173`
**Issue:** The comment `// The child will receive isNewFile=true` describes intended behavior but no code implements it. After creating a new file and reloading children, there is no mechanism to mark the newly created child entry for inline rename with `isNewFile=true`. This is effectively a TODO comment for incomplete functionality.
**Fix:** Either implement the inline-rename-on-create flow or replace the comment with a `// TODO:` marker to make the gap explicit.

---

_Reviewed: 2026-04-12T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
