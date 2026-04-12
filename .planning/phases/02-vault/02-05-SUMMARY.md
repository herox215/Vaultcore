---
phase: 02-vault
plan: 05
subsystem: rust-merge, rust-watcher, frontend-editor, frontend-ipc
tags: [three-way-merge, similar, vault-unmount, disk-full, ERR-03, ERR-04, SYNC-06, SYNC-07, SYNC-08, TDD]
dependency_graph:
  requires:
    - 02-01 (merge.rs skeleton, similar crate, WriteIgnoreList)
    - 02-03 (tabStore, EditorPane, vaultStore)
    - 02-04 (watcher spawning, listenFileChange, listenVaultStatus stubs)
  provides:
    - merge.rs: three_way_merge (Myers line-level diff, Clean/Conflict outcomes)
    - merge_external_change Tauri command (path validation, disk read, three_way_merge call)
    - EditorPane.svelte: full merge integration (mergeExternalChange IPC, toast dispatch)
    - EditorPane.svelte: vault unmount/reconnect handling via listenVaultStatus
    - EditorPane.svelte: disk-full resilience with 30s toast debounce
    - tabStore: lastSavedContent field + setLastSavedContent method
    - vaultStore: vaultReachable field (Arc<Mutex<bool>>) + setVaultReachable method
    - watcher.rs: reconnect poll task (5s interval, vault_status{reachable:true} on restore)
    - commands.ts: mergeExternalChange IPC wrapper
  affects:
    - src-tauri/src/merge.rs (full implementation replacing todo!())
    - src-tauri/src/commands/vault.rs (merge_external_change command added)
    - src-tauri/src/lib.rs (vault_reachable: Arc<Mutex<bool>>, merge command registered)
    - src-tauri/src/watcher.rs (spawn_watcher gains vault_reachable param + reconnect task)
    - src-tauri/src/tests/merge.rs (8 new tests)
    - src-tauri/src/tests/mod.rs (mod merge added)
    - src/components/Editor/EditorPane.svelte (merge wired, vault status, disk-full)
    - src/store/vaultStore.ts (vaultReachable + setVaultReachable)
    - src/store/tabStore.ts (lastSavedContent + setLastSavedContent)
    - src/ipc/commands.ts (mergeExternalChange wrapper)
tech_stack:
  added: []
  patterns:
    - Myers line-level diff via similar::capture_diff_slices for three-way merge
    - Fast-path shortcuts: if left==right, base==left, or base==right — skip full diff
    - changed_base_ranges extracts Delete/Replace op ranges for conflict detection
    - ranges_overlap half-open interval check for conflict determination
    - apply_non_conflicting replays right's ops over left's content (left_replacement map)
    - Arc<Mutex<bool>> for vault_reachable — shared between VaultState and watcher poll task
    - tokio::spawn reconnect poll loop with 5s sleep, emits vault_status on restore
    - Disk-full toast debounced 30s (lastDiskFullToast timestamp check in EditorPane)
    - mergeExternalChange called async in handleExternalFileChange (replaces pendingMergePaths)
key_files:
  created:
    - src-tauri/src/tests/merge.rs
  modified:
    - src-tauri/src/merge.rs
    - src-tauri/src/commands/vault.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/watcher.rs
    - src-tauri/src/tests/mod.rs
    - src/components/Editor/EditorPane.svelte
    - src/store/vaultStore.ts
    - src/store/tabStore.ts
    - src/ipc/commands.ts
decisions:
  - vault_reachable promoted from Mutex<bool> to Arc<Mutex<bool>> to share with tokio reconnect-poll task — same lock semantics, just reference-counted
  - Disk-full toast debounced at 30s using a module-level timestamp in EditorPane — avoids toast flooding during extended disk-full conditions
  - apply_non_conflicting uses left_replacement + left_insert_before maps keyed by base-line index — cleanest approach for non-overlapping overlay without re-running Myers
  - mergeExternalChange IPC errors are silently ignored (file may have been deleted between watcher event and read) — delete event handles cleanup separately
  - Auto-mode checkpoint: Task 3 human-verify auto-approved (workflow.auto_advance=true)
metrics:
  duration: 18min
  completed: 2026-04-12T11:15:00Z
  tasks_completed: 3
  files_modified: 10
---

# Phase 02 Plan 05: Three-Way Merge and Error Resilience Summary

**One-liner:** Myers line-level three-way merge engine with Clean/Conflict outcomes wired end-to-end: EditorPane calls merge_external_change IPC on file_changed events, applies clean merges silently with toast, keeps local on conflict with toast, vault unmount disables editing with reconnect polling every 5s, disk-full toasts debounced at 30s.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing three-way merge tests | db026e0 | src-tauri/src/tests/merge.rs, tests/mod.rs |
| 1 (GREEN) | three_way_merge + merge_external_change command | 8d19dd2 | merge.rs, commands/vault.rs, lib.rs |
| 2 | Frontend merge integration, vault unmount, disk-full | ff16939 | EditorPane.svelte, vaultStore.ts, tabStore.ts, watcher.rs, commands.ts |
| 3 | Phase 2 end-to-end verification | — | Auto-approved (auto_advance=true) |

## Verification Results

- `cargo test --lib`: 59 passed, 0 failed (8 new merge tests + 51 prior)
- `npx vitest run`: 56 passed, 0 failed (all prior tests green)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] similar::DiffOp::Equal uses `len` not `old_len`**
- **Found during:** Task 1 GREEN (cargo compile)
- **Issue:** Plan pseudocode used `old_len` for the Equal variant field, but the `similar` crate's `DiffOp::Equal` struct has a single `len` field (not split into `old_len`/`new_len`). Delete/Replace variants correctly have `old_len`.
- **Fix:** Changed both Equal match arms to use `len` field.
- **Files modified:** src-tauri/src/merge.rs
- **Commit:** 8d19dd2

**2. [Rule 1 - Bug] AppHandle moved into closure before polling task could clone it**
- **Found during:** Task 2 Rust compile (watcher.rs)
- **Issue:** `app` was moved into the debouncer closure, then `app.clone()` was called after the move for the poll task — use-after-move error.
- **Fix:** Added `app_for_events = app.clone()` before closure capture, keeping original `app` for the polling task clones.
- **Files modified:** src-tauri/src/watcher.rs
- **Commit:** ff16939

**3. [Rule 2 - Missing] vault_reachable needed Arc<Mutex<bool>> not Mutex<bool>**
- **Found during:** Task 2 (watcher reconnect poll design)
- **Issue:** spawn_watcher now needs to share `vault_reachable` with a background tokio task, requiring `Clone`. Plain `Mutex<bool>` is not `Clone`; `Arc<Mutex<bool>>` is.
- **Fix:** Changed VaultState.vault_reachable from `Mutex<bool>` to `Arc<Mutex<bool>>`, updated Default impl and all access sites.
- **Files modified:** src-tauri/src/lib.rs, src-tauri/src/watcher.rs, src-tauri/src/commands/vault.rs
- **Commit:** ff16939

## Known Stubs

None — all Plan 05 functionality is fully implemented. The `pendingMergePaths` stub from Plan 04 is now replaced with the actual merge logic.

## Threat Surface Scan

| Mitigation | Implementation |
|------------|---------------|
| T-02-18: path validation before disk read | merge_external_change canonicalizes path and checks starts_with(vault_path) before std::fs::read_to_string |
| T-02-21: readonly bypass double-protection | overlay uses pointer-events:none AND auto-save skips when !vaultReachable |

## Self-Check: PASSED
