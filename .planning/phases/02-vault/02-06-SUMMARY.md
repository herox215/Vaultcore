---
phase: 02-vault
plan: "06"
subsystem: files-ipc, sidebar, editor
tags: [gap-closure, serde, svelte, i18n]
depends_on: ["02-05"]
provides: ["CR-01-fix", "CR-02-fix", "SC4-german-toasts"]
affects: ["rename_file IPC", "Sidebar TreeNode", "EditorPane merge toasts"]
tech_stack:
  added: []
  patterns: ["serde rename_all camelCase on IPC result structs", "Svelte explicit prop binding over shorthand"]
key_files:
  modified:
    - src-tauri/src/commands/files.rs
    - src/components/Sidebar/Sidebar.svelte
    - src/components/Editor/EditorPane.svelte
  created: []
decisions:
  - "serde rename_all camelCase is the correct pattern for all IPC result structs so TypeScript consumers receive camelCase field names"
  - "Svelte shorthand {onPathChanged} passes through the prop value as-is; explicit onPathChanged={handlePathChanged} is required when mapping a local function to a prop of the same name"
metrics:
  duration_seconds: 66
  completed_date: "2026-04-12"
  tasks_completed: 2
  files_modified: 3
requirements:
  - FILE-03
  - SYNC-06
  - SYNC-08
---

# Phase 02 Plan 06: Gap-Closure Fixes Summary

**One-liner:** Three single-line fixes closing CR-01 (RenameResult camelCase serde), CR-02 (Sidebar onPathChanged wiring), and SC#4 (German merge/conflict toast text).

## What Was Built

This plan closed three blocker gaps identified during Phase 02 verification:

1. **CR-01 — RenameResult camelCase serde** (`src-tauri/src/commands/files.rs`): Added `#[serde(rename_all = "camelCase")]` to `RenameResult` so `new_path` and `link_count` serialize as `newPath` and `linkCount`, matching TypeScript IPC consumer expectations. Without this fix, the wiki-link count prompt received `undefined` for both fields.

2. **CR-02 — Sidebar onPathChanged wiring** (`src/components/Sidebar/Sidebar.svelte`): Replaced Svelte shorthand `{onPathChanged}` with explicit `onPathChanged={handlePathChanged}` in the `TreeNode` loop. The shorthand form passes the `onPathChanged` prop value received from above rather than the locally defined `handlePathChanged` function, leaving sidebar refresh broken after rename.

3. **SC#4 — German toast text** (`src/components/Editor/EditorPane.svelte`): Replaced English merge toast `External changes merged into ${filename}.` with `Externe Änderungen wurden in ${filename} eingebunden.` and conflict toast `Conflict in ${filename} — local version kept.` with `Konflikt in ${filename} – lokale Version behalten.` (en-dash U+2013 as specified).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix RenameResult serde and Sidebar onPathChanged wiring | 553ad79 | files.rs, Sidebar.svelte |
| 2 | Replace English merge/conflict toasts with German text | 4b86ef8 | EditorPane.svelte |

## Verification Results

| Check | Result |
|-------|--------|
| `grep -c 'rename_all.*camelCase' src-tauri/src/commands/files.rs` | 1 |
| `grep -c 'onPathChanged={handlePathChanged}' src/components/Sidebar/Sidebar.svelte` | 1 |
| `grep -c 'Externe Änderungen' src/components/Editor/EditorPane.svelte` | 1 |
| `grep -c 'Konflikt in' src/components/Editor/EditorPane.svelte` | 1 |
| `grep -c 'External changes merged' src/components/Editor/EditorPane.svelte` | 0 |
| `cargo check` | Finished (no errors) |

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all three fixes wire real behavior (camelCase serialization, function reference, German string literals).

## Threat Flags

None - only attribute addition and string literal changes; no new trust boundaries or network surface introduced.

## Self-Check: PASSED

- `src-tauri/src/commands/files.rs` — modified (verified via grep)
- `src/components/Sidebar/Sidebar.svelte` — modified (verified via grep)
- `src/components/Editor/EditorPane.svelte` — modified (verified via grep)
- Commit 553ad79 — exists
- Commit 4b86ef8 — exists
