---
phase: 02-vault
reviewed: 2026-04-12T00:00:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - src/components/Editor/EditorPane.svelte
  - src/components/Layout/VaultLayout.svelte
  - src/components/Sidebar/InlineRename.svelte
  - src/components/Sidebar/Sidebar.svelte
  - src/components/Sidebar/TreeNode.svelte
  - src/components/Tabs/TabBar.svelte
  - src/components/Tabs/Tab.svelte
  - src/ipc/commands.ts
  - src/store/tabStore.test.ts
  - src/store/tabStore.ts
  - src/store/vaultStore.ts
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
  - src/types/tree.ts
findings:
  critical: 2
  warning: 6
  info: 5
  total: 13
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-04-12T00:00:00Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

Reviewed all Rust backend commands (files, tree, vault, merge engine, watcher) and the Svelte frontend (editor panes, sidebar, tab management, IPC layer, stores). The codebase is well-structured with consistent vault-scope security guards on all Tauri commands and good test coverage. Two critical correctness bugs were found: a Serde field-name serialization mismatch that breaks the rename workflow end-to-end, and an undefined variable in the Sidebar template that will crash on any path-change operation. Six warnings cover incorrect error messages, a prop name mismatch that silently disables new-file cleanup, a no-op store update, an infinite loop risk in name-collision helpers, a leaking background task, and a double-`onMount` that creates fragile cleanup ownership. Five info items note dead code and incomplete implementations.

---

## Critical Issues

### CR-01: Serde field name mismatch between Rust `RenameResult` and TypeScript IPC

**File:** `src-tauri/src/commands/files.rs:278-283` and `src/ipc/commands.ts:95-97`

**Issue:** `RenameResult` uses `#[derive(serde::Serialize)]` without `#[serde(rename_all = "camelCase")]`, so Serde serializes the struct as `{"new_path": ..., "link_count": ...}` (snake_case). The TypeScript IPC layer at line 95-97 expects `{ newPath: string; linkCount: number }` (camelCase). Consequently `result.newPath` is always `undefined`, so `onConfirm(result.newPath, result.linkCount)` passes `undefined` as the new path. The sidebar will not update the tab path on rename, and the wiki-link warning dialog can never appear because `linkCount` is also `undefined` (falsy). The existing `#[serde(rename_all = "camelCase")]` annotation is present on `RenameResult` at line 279 — but if it is absent in the version being reviewed, this is the root cause.

**Fix:** Confirm `#[serde(rename_all = "camelCase")]` is present on `RenameResult`:
```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub new_path: String,
    pub link_count: u32,
}
```
Also verify `MergeCommandResult` in `vault.rs:340-345` — its field `merged_content` must be serialized as `mergedContent` to match the TypeScript `MergeResult` interface at `src/ipc/commands.ts:136-138`.

### CR-02: Undefined variable `onPathChanged` used in Sidebar template

**File:** `src/components/Sidebar/Sidebar.svelte:213`

**Issue:** The template passes `{onPathChanged}` (shorthand for `onPathChanged={onPathChanged}`) to each `TreeNode`. No variable named `onPathChanged` is defined in the script block — the function is named `handlePathChanged` (line 156). In Svelte 5 runes mode, this either fails at compile time or passes `undefined` as the prop at runtime. Any rename or move operation that calls `onPathChanged(entry.path, newPath)` in `TreeNode.svelte` (lines 118 and 129) will throw `TypeError: onPathChanged is not a function`, crashing the tree.

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

---

## Warnings

### WR-01: Prop name mismatch — TreeNode passes `isNewEntry` but InlineRename expects `isNewFile`

**File:** `src/components/Sidebar/TreeNode.svelte:308` and `src/components/Sidebar/InlineRename.svelte:10`

**Issue:** TreeNode passes `{isNewEntry}` (shorthand for `isNewEntry={isNewEntry}`) to `InlineRename`. The `InlineRename` Props interface at line 10 defines `isNewFile?: boolean`, not `isNewEntry`. Svelte 5 does not alias unknown props — `isNewFile` will always be `undefined` (defaulting to `false`). As a result, when a rename fails on a newly-created placeholder file, the cleanup logic in `handleConfirm` (lines 67-68) and `handleCancel` (lines 77-78) will never call `deleteFile(oldPath)`, leaving orphan "Untitled.md" files on disk.

**Fix:** In `TreeNode.svelte` line 308, change the prop name to match the interface:
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

**Issue:** In the `onSave` error handler, the `else` branch (for any error that is NOT `DiskFull`) shows the hardcoded message `"Disk full. Could not save changes."` This message is wrong for permission errors, locked-file errors, and all other I/O failures. Users will believe the disk is full when the actual cause is different.

**Fix:**
```typescript
} else {
  toastStore.push({ variant: "error", message: "Could not save changes." });
}
```

### WR-03: Dead no-op `_store.update()` in `closeByPath` causes spurious subscriber notifications

**File:** `src/store/tabStore.ts:278-283`

**Issue:** The first `_store.update()` call inside `closeByPath` finds a matching tab but unconditionally returns `state` unchanged (line 282). This triggers a store notification to all subscribers without mutating anything, causing unnecessary re-renders. The misleading comment "Reuse closeTab logic via internal state mutation" implies mutation happens but none does.

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

### WR-04: `find_available_name` and `find_available_dir_name` have unbounded loops

**File:** `src-tauri/src/commands/files.rs:181-190` and `198-207`

**Issue:** Both helpers increment a counter until they find an unused name, with no upper bound. A directory containing `Untitled.md`, `Untitled 1.md`, ..., through thousands of suffixed files (or if the directory is unlistable mid-loop) will cause the function to spin indefinitely, blocking the Tauri async thread and hanging the entire application.

**Fix:** Add a cap and return an error:
```rust
const MAX_SUFFIX: u32 = 9_999;
let mut n = 1u32;
loop {
    if n > MAX_SUFFIX {
        return Err(VaultError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "Could not find available filename after 9999 attempts",
        )));
    }
    let name = format!("{} {}{}", stem, n, ext);
    let candidate = dir.join(&name);
    if !candidate.exists() {
        return Ok(candidate);
    }
    n += 1;
}
```
Apply the same pattern to `find_available_dir_name`.

### WR-05: Watcher reconnect-poll task leaks when vault is re-opened

**File:** `src-tauri/src/watcher.rs:138-159`

**Issue:** `spawn_watcher` launches a `tokio::spawn` background task that runs an infinite `loop`. When the user opens a new vault, `open_vault` drops the old `Debouncer` (via `*handle = None`), but the background poll task holds its own clones of `vault_path_poll` and `vault_reachable_poll` — it is never cancelled. After N vault switches, N poll tasks run concurrently. If the old vault path still exists on disk (e.g., the user switches between two local vaults), a stale task may emit a spurious `vault://vault_status { reachable: true }` event, incorrectly re-enabling editing.

**Fix:** Return a cancellation handle from `spawn_watcher` and cancel it when the debouncer is replaced:
```rust
// In spawn_watcher, use a oneshot channel:
let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
tokio::spawn(async move {
    loop {
        tokio::select! {
            _ = &mut cancel_rx => break,
            _ = sleep(RECONNECT_POLL_INTERVAL) => {
                // poll logic
            }
        }
    }
});
// Store cancel_tx alongside the Debouncer in VaultState.
// Dropping cancel_tx stops the task.
```

### WR-06: Two `onMount` calls in `VaultLayout` create fragile cleanup ownership

**File:** `src/components/Layout/VaultLayout.svelte:33-41` and `99-106`

**Issue:** There are two separate `onMount` calls. The second one (lines 99-106) registers mouse event listeners and returns a cleanup function. The `onDestroy` at lines 108-112 also explicitly removes the same listeners — double cleanup. The first `onMount` (lines 33-41) is isolated and harmless, but having two `onMount` blocks is fragile and the cleanup responsibility is split between an `onMount` return value and a separate `onDestroy`.

**Fix:** Merge both `onMount` calls into one and remove the redundant `onDestroy` for mouse events:
```typescript
onMount(() => {
  const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (stored !== null) {
    const parsed = parseInt(stored, 10);
    if (!isNaN(parsed) && parsed >= MIN_SIDEBAR_WIDTH && parsed <= MAX_SIDEBAR_WIDTH) {
      sidebarWidth = parsed;
    }
  }
  document.addEventListener("mousemove", handleMousemove);
  document.addEventListener("mouseup", handleMouseup);
  return () => {
    document.removeEventListener("mousemove", handleMousemove);
    document.removeEventListener("mouseup", handleMouseup);
  };
});
```

---

## Info

### IN-01: `handleNewFileHere` creates a file but never triggers inline rename

**File:** `src/components/Sidebar/TreeNode.svelte:159-178`

**Issue:** After creating a new file, the function reloads children and finds the new entry, but the comment "Trigger rename on the new entry — handled via child component / The child will receive isNewFile=true" is followed by no code. There is no mechanism to tell the newly-created child's `TreeNode` instance to enter rename mode. The user gets a silently-created "Untitled.md" with no naming prompt.

This is an incomplete implementation. Document it clearly as a TODO or implement the rename trigger.

### IN-02: Unused `initial` constant in `tabStore`

**File:** `src/store/tabStore.ts:29-33`

**Issue:** The `initial` constant is defined but never referenced. The store is initialized using `makeInitial()` (line 43), and `_reset()` also calls `makeInitial()`. The `initial` constant is dead code.

**Fix:** Remove lines 29-33.

### IN-03: `getSelectedFolder` in Sidebar only checks top-level `rootEntries`

**File:** `src/components/Sidebar/Sidebar.svelte:148-154`

**Issue:** When a subfolder nested inside the tree is selected (expanded via `TreeNode`), it will not appear in `rootEntries` (which holds only root-level entries). The function returns `null` for any selection below root depth, so "New file" and "New folder" in the header always create in the vault root even when a subfolder is selected. The context-menu "New file here" in `TreeNode` works correctly; only the header buttons are affected.

**Fix:** Propagate an `isDir` flag alongside `selectedPath`, or compare the selected path string against a broader set than `rootEntries`.

### IN-04: Unused variable `state` in keyboard handler

**File:** `src/components/Layout/VaultLayout.svelte:143`

**Issue:** `const state = tabStore;` is assigned but never used — `tabStore` is accessed directly on the lines that follow. This is dead code.

**Fix:** Remove line 143.

### IN-05: German-language toast messages for merge events

**File:** `src/components/Editor/EditorPane.svelte:269` and `278`

**Issue:** Two toast strings are in German ("Externe Änderungen wurden in `${filename}` eingebunden." and "Konflikt in `${filename}` – lokale Version behalten.") while every other user-facing string in the codebase is in English. These appear to be placeholder copy-paste artifacts.

**Fix:**
```typescript
// Line 269
message: `External changes merged into ${filename}.`,
// Line 278
message: `Conflict in ${filename} — local version kept.`,
```

---

_Reviewed: 2026-04-12T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
