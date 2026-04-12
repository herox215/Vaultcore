---
phase: 02-vault
plan: 01
subsystem: rust-backend, frontend-ipc
tags: [list_directory, VaultState, IPC, types, crate-additions, TDD]
dependency_graph:
  requires: []
  provides:
    - list_directory Rust command (vault-scoped, dot-filtered, symlink-aware, folder-first sorted)
    - DirEntry TypeScript interface
    - Phase 2 IPC command wrappers (listDirectory, createFile, renameFile, deleteFile, moveFile, createFolder, countWikiLinks)
    - Phase 2 event listeners (listenFileChange, listenVaultStatus, listenBulkChangeStart, listenBulkChangeEnd)
    - WriteIgnoreList struct (D-12 write-token self-filtering)
    - watcher.rs and merge.rs module skeletons
  affects:
    - src-tauri/src/lib.rs (VaultState extended, new modules registered)
    - src/ipc/commands.ts (new wrappers added)
    - src/ipc/events.ts (new listeners added)
tech_stack:
  added:
    - notify-debouncer-full = "0.7" (file watcher, used in Plan 04)
    - similar = "3.1" (three-way merge diffing, used in Plan 05)
    - rayon = "1" (batch parallelism for SYNC-04)
    - regex = "1" (wiki-link counting for D-16 rename flow)
  patterns:
    - _impl helper pattern for testable Tauri command bodies (mirrors files.rs approach)
    - symlink_metadata() for is_symlink detection, metadata() for is_dir display type
    - folder-first sort via sort_by with (is_dir, is_dir) match arm
key_files:
  created:
    - src-tauri/src/commands/tree.rs
    - src-tauri/src/watcher.rs
    - src-tauri/src/merge.rs
    - src-tauri/src/tests/tree.rs
    - src/types/tree.ts
  modified:
    - src-tauri/Cargo.toml (4 new crates added)
    - src-tauri/src/lib.rs (VaultState extended, modules declared, invoke_handler updated)
    - src-tauri/src/commands/mod.rs (pub mod tree added)
    - src-tauri/src/tests/mod.rs (mod tree added)
    - src/ipc/commands.ts (7 new wrappers added)
    - src/ipc/events.ts (4 new listeners + payloads added)
decisions:
  - regex crate added beyond D-20 spec (which listed only notify-debouncer-full and similar) — required for D-16 wiki-link counting in rename flow per plan notes and RESEARCH resolution
  - watcher_handle field deferred to Plan 04 (Debouncer has no Default, would break VaultState::default())
  - list_directory_impl uses dual metadata calls: symlink_metadata() for is_symlink, entry.metadata() for is_dir (follows symlink for display type, per D-05)
metrics:
  duration: 4min
  completed: 2026-04-12T08:15:51Z
  tasks_completed: 2
  files_modified: 11
---

# Phase 02 Plan 01: Rust Backend Foundation Summary

**One-liner:** list_directory Tauri command with vault-scope guard, dot-filtering, symlink detection, and folder-first sorting; four new Cargo crates; VaultState extended with WriteIgnoreList; watcher.rs and merge.rs skeletons; full Phase 2 TypeScript IPC surface.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Rust crate additions, VaultState extension, list_directory command, module skeletons | 3dc5be7 (tests), 0a62f87 (impl) | Cargo.toml, lib.rs, commands/mod.rs, commands/tree.rs, watcher.rs, merge.rs, tests/tree.rs |
| 2 | Frontend types, IPC wrappers, event listeners | 54abbd7 | src/types/tree.ts, src/ipc/commands.ts, src/ipc/events.ts |

## Verification Results

- `cargo test --lib`: 34 passed, 0 failed
- `npx tsc --noEmit`: exit 0 (no errors)

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written, with one minor implementation detail noted:

**1. [Discretion] Dual metadata call pattern for symlink detection**
- The `list_directory_impl` uses `entry.metadata()` (follows symlinks, for `is_dir`) AND `std::fs::symlink_metadata(entry.path())` (does not follow, for `is_symlink`). This is the correct approach per D-05 but the plan's pseudocode used `metadata()` for type and `symlink_metadata()` for symlink detection without being explicit — the implementation followed the correct platform-correct pattern.

## Known Stubs

- `src-tauri/src/merge.rs`: `three_way_merge` is `todo!("Implemented in Plan 05")` — intentional skeleton, wired in Plan 05.
- `src-tauri/src/watcher.rs`: empty skeleton — intentional, wired in Plan 04.
- `src/ipc/commands.ts`: `createFile`, `renameFile`, `deleteFile`, `moveFile`, `createFolder`, `countWikiLinks` wrappers reference Rust commands that don't exist yet — intentional, implemented in Plans 02/03.

## Threat Surface Scan

All security-relevant surfaces in this plan are covered by the threat model:

| Mitigation | Implementation |
|-----------|----------------|
| T-02-01: path validation | `check_inside_vault()` in tree.rs canonicalizes and checks `starts_with(vault)` before `read_dir` |
| T-02-02: dot-prefix filtering | `name.starts_with('.')` guard filters .obsidian, .git, .trash etc. |
| T-02-03: canonical paths in DirEntry | `entry_path = canonical_dir.join(&name)` — never returns user-supplied strings |

## Self-Check: PASSED

All files created/modified exist on disk. All task commits verified in git log:
- 3dc5be7: test(02-01) — failing tests
- 0a62f87: feat(02-01) — Rust implementation
- 54abbd7: feat(02-01) — frontend types/IPC
