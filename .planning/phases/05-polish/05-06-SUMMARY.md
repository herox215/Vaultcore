---
phase: 05-polish
plan: "06"
subsystem: editor
tags: [edit-10, auto-save, hash-verify, merge, rust, ipc, vitest]
dependency_graph:
  requires: [05-00, 05-03, 05-04]
  provides: [hash-verify-merge-path]
  affects: [EditorPane, autoSave, commands/files]
tech_stack:
  added: []
  patterns:
    - impl-split pattern (get_file_hash_impl + tauri command wrapper)
    - savingPromise + pendingReschedule pattern for async-aware debounce
    - lastSavedHashSnapshot via store subscribe for synchronous access in async callback
key_files:
  created:
    - src-tauri/src/tests/hash_verify.rs
    - src/components/Editor/__tests__/autoSaveHashVerify.test.ts
  modified:
    - src-tauri/src/commands/files.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/tests/mod.rs
    - src/ipc/commands.ts
    - src/components/Editor/autoSave.ts
    - src/components/Editor/EditorPane.svelte
decisions:
  - "savingPromise only set for real Promise returns — synchronous onSave (void) skips async-deferral path, preserving backward compat with existing EDIT-09 tests"
  - "lastSavedHashSnapshot mirrors editorStore via subscribe at component scope — avoids get() import and is consistent with D-06/RC-01 classic writable store pattern"
  - "clean-merge variant used (not merge) — matches existing ToastVariant union in toastStore.ts"
metrics:
  duration: "6 minutes"
  completed_date: "2026-04-12"
  tasks_completed: 3
  files_modified: 8
---

# Phase 5 Plan 06: Hash-verify merge path in autoSave (EDIT-08, EDIT-10) Summary

**One-liner:** SHA-256 hash-verify before every auto-save write, routing mismatches through the Phase 2 three-way merge engine via a new `get_file_hash` IPC command, with async-aware debounce in the autoSave extension.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add get_file_hash Rust command | 1ee595a | commands/files.rs, lib.rs, tests/hash_verify.rs |
| 2 | Widen autoSave to async + getFileHash TS wrapper | bab2db5 | autoSave.ts, ipc/commands.ts, autoSaveHashVerify.test.ts |
| 3 | Wire hash-verify branch in EditorPane.onSave | e87c1fc | EditorPane.svelte |

## What Was Built

### get_file_hash Rust command (Task 1)

`get_file_hash_impl(state, path)` reads file bytes via `std::fs::read`, applies the existing `ensure_inside_vault` guard (T-05-06-01 path-traversal mitigation), and returns `hash_bytes(&bytes)` — the same SHA-256 hex helper used by `write_file`. The `#[tauri::command]` async wrapper delegates to the impl, following the `list_directory_impl` split pattern so unit tests can call the impl directly without constructing `tauri::State`. Registered in `tauri::generate_handler!`.

5 unit tests in `tests/hash_verify.rs` cover: correct SHA-256 output, vault-scope rejection (PermissionDenied), missing path (FileNotFound), determinism for same content, and changed hash on mutation.

### Async-aware autoSave (Task 2)

`autoSaveExtension` widened from `onSave: (text) => void` to `(text) => Promise<void> | void`. When `onSave` returns a real `Promise`, `savingPromise` is set and a `pendingReschedule` flag tracks any `docChanged` events that arrive during the in-flight save. Once the promise settles, `finally` clears `savingPromise` and schedules the deferred timer if needed. Synchronous `onSave` (returns `undefined`) bypasses the deferral path — preserving backward compatibility with the existing EDIT-09 test suite.

`getFileHash(path)` wrapper added to `src/ipc/commands.ts` next to `writeFile`.

4 Vitest tests cover: single-fire debounce, timer-reset, async deferral (no overlap), and IPC wrapper resolution.

### Hash-verify branch in EditorPane.onSave (Task 3)

`onSave` in `mountEditorView` now:
1. Calls `getFileHash(tab.filePath)` — catches `FileNotFound` (external delete → fall through to write) and re-throws other errors.
2. Compares `diskHash` against `lastSavedHashSnapshot` (mirrored from `editorStore.lastSavedHash` via subscribe).
3. **Mismatch path:** calls `mergeExternalChange(path, editorText, tab.lastSavedContent)`, applies `result.merged_content` to the CM6 view, writes merged content to disk via `writeFile`, updates `editorStore.lastSavedHash` and `tabStore.lastSavedContent`. Pushes `clean-merge` or `conflict` toast with the exact Phase 2 German strings.
4. **Match path (or file missing):** direct `writeFile` as before.

`unsubEditorHash` added to `onDestroy` cleanup.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed async deferral incompatibility with synchronous onSave**
- **Found during:** Task 3 — full Vitest suite run
- **Issue:** Using `Promise.resolve(result)` wraps synchronous `undefined` in a Promise, causing `savingPromise` to remain set until the next microtask tick. The existing EDIT-09 test uses synchronous `vi.advanceTimersByTime` which doesn't flush microtasks, so the second `docChanged` dispatch saw `savingPromise !== null` and was incorrectly deferred.
- **Fix:** Changed `savingPromise = Promise.resolve(result)` to `if (result instanceof Promise) { savingPromise = result; }` — only blocks on a real async save.
- **Files modified:** `src/components/Editor/autoSave.ts`
- **Commit:** e87c1fc (included in Task 3 commit)

**2. [Rule 2 - Missing critical detail] Used correct toast variant "clean-merge" not "merge"**
- **Found during:** Task 3 implementation
- **Issue:** Plan pseudocode used `variant: "merge"` which is not a valid `ToastVariant` (union is `"error" | "conflict" | "clean-merge"`).
- **Fix:** Changed to `variant: "clean-merge"` to match the existing `toastStore.ts` type.
- **Files modified:** `src/components/Editor/EditorPane.svelte`
- **Commit:** e87c1fc

## Known Stubs

None — all data flows are wired to real IPC.

## Threat Flags

No new security surface beyond what the plan's threat model covers. The `get_file_hash` command follows the identical vault-scope guard as `read_file`.

## Self-Check

- [x] `src-tauri/src/tests/hash_verify.rs` — created
- [x] `src/components/Editor/__tests__/autoSaveHashVerify.test.ts` — created
- [x] `src-tauri/src/commands/files.rs` — get_file_hash_impl + get_file_hash present
- [x] `src-tauri/src/lib.rs` — get_file_hash registered
- [x] `src/ipc/commands.ts` — getFileHash exported
- [x] `src/components/Editor/autoSave.ts` — async-aware with savingPromise
- [x] `src/components/Editor/EditorPane.svelte` — hash-verify branch wired

## Self-Check: PASSED

All commits exist: 1ee595a, bab2db5, e87c1fc. All 107 frontend tests pass. All 5 Rust hash_verify tests pass. No new TypeScript errors in modified files.
