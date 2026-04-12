---
phase: 02-vault
plan: 04
subsystem: rust-watcher, frontend-sidebar, frontend-editor
tags: [file-watcher, notify-debouncer-full, WriteIgnoreList, bulk-change, self-filtering, sidebar-refresh, TDD]
dependency_graph:
  requires:
    - 02-01 (WriteIgnoreList in VaultState, events.ts stubs)
    - 02-02 (Sidebar.svelte, VaultLayout, tree)
    - 02-03 (tabStore.closeByPath, tabStore.updateFilePath, EditorPane)
  provides:
    - watcher.rs: spawn_watcher, is_hidden_path, process_events, FileChangePayload, BulkChangePayload
    - VaultState.watcher_handle: Arc<Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>>
    - open_vault: spawns watcher after file-list walk
    - write_file: records in write_ignore before fs::write
    - Sidebar.svelte: listenFileChange, listenBulkChangeStart, listenBulkChangeEnd subscriptions; bulk progress strip
    - EditorPane.svelte: listenFileChange per-pane; pendingMergePaths queue; TODO Plan 05 merge hook
  affects:
    - src-tauri/src/watcher.rs (new implementation)
    - src-tauri/src/lib.rs (VaultState extended with watcher_handle)
    - src-tauri/src/commands/vault.rs (spawn_watcher call in open_vault)
    - src-tauri/src/commands/files.rs (write_ignore.record in write_file)
    - src-tauri/src/tests/watcher.rs (new test file)
    - src-tauri/src/tests/mod.rs (watcher test module added)
    - src/components/Sidebar/Sidebar.svelte (watcher subscriptions, bulk progress UI)
    - src/components/Editor/EditorPane.svelte (watcher subscription, merge hook points)
tech_stack:
  added: []
  patterns:
    - RecommendedCache (not FileIdMap) for Debouncer type — Linux maps FileIdMap->NoCache, use RecommendedCache alias
    - Arc<Mutex<Option<Debouncer<...>>>> for watcher handle storage (Debouncer has no Default)
    - is_hidden_path(vault_path, event_path) pub(crate) for dot-prefix test isolation
    - pendingMergePaths Set in EditorPane as hook point for Plan 05 three-way merge
    - bulkActive/$state flag in Sidebar replaces header strip with "Scanning changes..." during bursts
key_files:
  created:
    - src-tauri/src/tests/watcher.rs
  modified:
    - src-tauri/src/watcher.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/commands/vault.rs
    - src-tauri/src/commands/files.rs
    - src-tauri/src/tests/mod.rs
    - src/components/Sidebar/Sidebar.svelte
    - src/components/Editor/EditorPane.svelte
decisions:
  - RecommendedCache used instead of FileIdMap for Debouncer type parameter — on Linux new_debouncer returns Debouncer<INotifyWatcher, NoCache> not FileIdMap; RecommendedCache is the correct platform-agnostic alias
  - is_hidden_path extracted as pub(crate) function for unit-test isolation — process_events requires AppHandle so cannot be tested directly
  - pendingMergePaths is a Set<string> in EditorPane (not a Svelte store) — merge state is ephemeral, per-pane, not shared across components
  - Sidebar bulk progress replaces header strip inline (not a separate overlay) — keeps 40px height constraint without layout shift
metrics:
  duration: 5min
  completed: 2026-04-12T10:41:00Z
  tasks_completed: 2
  files_modified: 8
---

# Phase 02 Plan 04: File Watcher Pipeline Summary

**One-liner:** notify-debouncer-full watcher spawned on vault open with 200ms debounce, dot-prefix filtering, WriteIgnoreList self-write suppression, 500-event bulk threshold emitting vault://bulk_change_start/end, and Sidebar/EditorPane subscriptions for tree refresh, tab close/rename, and Plan 05 merge hook points.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing watcher unit tests | b37c88f | src-tauri/src/tests/watcher.rs, tests/mod.rs |
| 1 (GREEN) | watcher.rs, VaultState, open_vault, write_file | b37c88f | watcher.rs, lib.rs, vault.rs, files.rs |
| 2 | Sidebar watcher subscriptions + bulk UI; EditorPane merge hooks | 2d98438 | Sidebar.svelte, EditorPane.svelte |

## Verification Results

- `cargo test --lib`: 51 passed, 0 failed (7 new watcher tests + 44 prior)
- `npx vitest run`: 56 passed, 0 failed (all prior tests green)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] FileIdMap vs RecommendedCache type mismatch on Linux**
- **Found during:** Task 1 GREEN (cargo compile)
- **Issue:** The plan specified `Arc<Mutex<Option<Debouncer<RecommendedWatcher, FileIdMap>>>>` but `new_debouncer()` on Linux returns `Debouncer<INotifyWatcher, NoCache>` (FileIdMap is only used on macOS/Windows). Using `FileIdMap` caused a type mismatch error.
- **Fix:** Changed both `watcher.rs` return type and `VaultState.watcher_handle` field to use `RecommendedCache` — the platform-agnostic type alias that resolves to `FileIdMap` on macOS/Windows and `NoCache` on Linux.
- **Files modified:** src-tauri/src/watcher.rs, src-tauri/src/lib.rs
- **Commit:** b37c88f

## Known Stubs

- `EditorPane.svelte`: `pendingMergePaths.add(path)` on external modify — the merge queue records paths needing merge but Plan 05 provides the actual three-way merge logic. The hook point is present with `// TODO Plan 05: three_way_merge` comment.
- `EditorPane.svelte` line 34: `vaultReachable = $state(true)` — carried forward from Plan 03. Plan 05 wires the watcher-based ERR-03 trigger.

## Threat Surface Scan

All security-relevant surfaces are covered by the plan's threat model:

| Mitigation | Implementation |
|------------|---------------|
| T-02-14: filter events for paths outside vault root | `is_hidden_path()` filters dot-prefixed components; `map_event_to_payload()` checks `p.starts_with(vault_path)` before emitting |
| T-02-15: bulk event DoS | `BULK_THRESHOLD = 500` switches to batch mode; events still processed sequentially, not per-file toasts |
| T-02-16: path info disclosure | `map_event_to_payload()` returns `None` for paths outside vault scope |
| T-02-17: write-ignore memory leak | `WriteIgnoreList.record()` prunes entries older than 500ms on each call |

## Self-Check: PASSED
