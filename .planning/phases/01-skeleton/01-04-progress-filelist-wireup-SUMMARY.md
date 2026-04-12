---
phase: 01-skeleton
plan: 04
subsystem: wireup
tags: [progress-events, file-list, vaultview, e2e-wiring, idx-02]

# Dependency graph
requires:
  - phase: 01-skeleton/00
    provides: vitest scaffolds, CSS variables, component dirs
  - phase: 01-skeleton/01
    provides: Rust backend IPC (open_vault, read_file, write_file), VaultError enum
  - phase: 01-skeleton/02
    provides: stores (vaultStore, editorStore, progressStore, toastStore), IPC commands wrapper, WelcomeScreen, ToastContainer
  - phase: 01-skeleton/03
    provides: CMEditor.svelte with buildExtensions, autoSaveExtension, vaultKeymap
provides:
  - Two-pass vault walk with throttled vault://index_progress events
  - collect_file_list returning sorted relative paths with forward slashes
  - listenIndexProgress typed event wrapper
  - ProgressBar.svelte UI-SPEC progress card
  - VaultView.svelte flat file list with click-to-open CMEditor
  - FileListRow.svelte with active highlight
  - Full App.svelte routing Welcome -> VaultView with progress + toast wiring
affects: [02-files, 03-search, 05-polish]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-pass walkdir: count pass then emit pass with 50ms throttle"
    - "Forward-slash path normalization for cross-platform file list"
    - "Tauri Emitter trait for app.emit() event broadcasting"
    - "vi.hoisted pattern for vitest mock factories"
    - "{#key $editorStore.activePath} for CM6 history reset on file switch"
    - "Synchronous onSave wrapper bridging async writeFile to CM6 callback"

key-files:
  created:
    - src/ipc/events.ts
    - src/components/Progress/ProgressBar.svelte
    - src/components/Welcome/VaultView.svelte
    - src/components/Welcome/FileListRow.svelte
  modified:
    - src-tauri/src/commands/vault.rs
    - src-tauri/src/tests/vault_stats.rs
    - src/types/vault.ts
    - src/App.svelte
    - tests/indexProgress.test.ts

key-decisions:
  - "50ms throttle on vault://index_progress events (PROGRESS_THROTTLE constant)"
  - "collect_file_list uses forward-slash normalization via replace('\\\\', '/') for all platforms"
  - "VaultView uses grid layout: 200-280px file list + 1fr editor pane"
  - "CMEditor remount via {#key} ensures history reset between files"
  - "vi.hoisted used instead of top-level const for vitest mock factory compatibility"

patterns-established:
  - "Tauri event listener pattern: listenIndexProgress returns UnlistenFn, App.svelte stores and calls in onDestroy"
  - "File open flow: click FileListRow -> readFile IPC -> editorStore.openFile -> CMEditor mounts"
  - "Save flow: CMEditor onSave -> writeFile IPC -> editorStore.setLastSavedHash, toast on error"

requirements-completed: [IDX-02]

# Metrics
duration: ~6min
completed: 2026-04-12
---

# Phase 1 Plan 4: Progress + File List Wire-up Summary

**Two-pass vault walk with 50ms-throttled vault://index_progress events, typed event listener, UI-SPEC ProgressBar, flat D-14 file list in VaultView with click-to-open CMEditor, autoSave wired through writeFile with toast error handling -- Phase 1 end-to-end skeleton complete.**

## Performance

- **Duration:** ~6 minutes
- **Started:** 2026-04-12T05:58:55Z
- **Completed:** 2026-04-12T06:05:04Z
- **Tasks:** 4 (3 auto + 1 checkpoint auto-approved)
- **Files created:** 4
- **Files modified:** 5

## Accomplishments

- `open_vault` upgraded to two-pass walk: first pass counts `.md` files via `count_md_files`, second pass collects sorted relative paths via `collect_file_list` and emits throttled `vault://index_progress` events (<=50ms cadence via `PROGRESS_THROTTLE`). `VaultInfo` now includes `file_list: Vec<String>` with forward-slash separators on all platforms.
- `listenIndexProgress` in `src/ipc/events.ts` wraps `@tauri-apps/api/event::listen` with typed `IndexProgressPayload` interface. Exported `INDEX_PROGRESS_EVENT` constant for test assertions.
- `ProgressBar.svelte` implements UI-SPEC progress card: fixed overlay, 400px card, "Scanning vault..." label, comma-formatted counter, 8px accent-fill progress bar with 120ms transition, middle-truncated current file path.
- `VaultView.svelte` renders flat D-14 file list in a grid layout (200-280px sidebar + 1fr editor pane). Click a row calls `readFile` IPC, pipes content to `editorStore.openFile`, which mounts `CMEditor` via `{#key $editorStore.activePath}` for per-file history reset.
- `FileListRow.svelte` is a button element with active highlight (accent left-border + accent-bg), hover state, and RTL middle-truncation for long paths.
- `App.svelte` fully wired: subscribes to `listenIndexProgress` in `onMount` (cleanup in `onDestroy`), routes events to `progressStore.update`, calls `progressStore.start(0)` before `openVault` and `progressStore.finish()` after resolve/reject. Routes between `WelcomeScreen` and `VaultView` based on `$vaultStore.status`. Mounts `ProgressBar` and `ToastContainer` globally.
- `tests/indexProgress.test.ts` upgraded from 2 `it.todo` stubs to 4 passing assertions using `vi.hoisted` + `vi.mock` pattern for Tauri event module mocking.
- Full test suite: 35 Vitest tests (0 todo), 27 cargo tests -- all green.

## Task Commits

1. **Task 1: Backend two-pass walk with progress events + file list** -- `01bca1f` (feat)
2. **Task 2: Event listener + ProgressBar + IDX-02 tests** -- `5a942eb` (feat)
3. **Task 3: VaultView + FileListRow + App.svelte wire-up** -- `4fb0a2b` (feat)
4. **Task 4: Phase 1 E2E checkpoint** -- auto-approved (workflow.auto_advance: true)

## Files Created/Modified

- `src-tauri/src/commands/vault.rs` -- two-pass walk, collect_file_list, IndexProgressPayload, PROGRESS_THROTTLE, Emitter import
- `src-tauri/src/tests/vault_stats.rs` -- collect_file_list_sorted_and_normalized test
- `src/ipc/events.ts` -- listenIndexProgress, IndexProgressPayload, INDEX_PROGRESS_EVENT
- `src/components/Progress/ProgressBar.svelte` -- UI-SPEC progress card
- `src/components/Welcome/VaultView.svelte` -- flat file list + editor pane
- `src/components/Welcome/FileListRow.svelte` -- clickable row with active highlight
- `src/types/vault.ts` -- VaultInfo.file_list added
- `src/App.svelte` -- full routing + progress subscription + VaultView mount
- `tests/indexProgress.test.ts` -- 4 IDX-02 assertions (was it.todo)

## Decisions Made

- **50ms throttle chosen** -- matches RESEARCH recommendation, produces ~20 events/second max for 100k vaults
- **collect_file_list as separate public function** -- testable independently, reusable by Phase 3 when real indexer replaces the walk body
- **vi.hoisted for mock factory** -- required by vitest 4.x hoisting semantics, prevents ReferenceError
- **Grid layout for VaultView** -- 200-280px flexible file list width provides readable path display without wasting screen space

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] vi.mock factory hoisting fix**
- **Found during:** Task 2
- **Issue:** `vi.mock` factory cannot reference module-scoped `const mockListen` because vi.mock is hoisted above variable declarations in vitest 4.x
- **Fix:** Used `vi.hoisted(() => { ... })` to declare `mockListen` in hoisted scope
- **Files modified:** tests/indexProgress.test.ts
- **Commit:** 5a942eb

## Issues Encountered

None beyond the vi.hoisted fix above.

## Known Stubs

None -- all Phase 1 stubs from prior plans are now resolved:
- CMEditor is mounted in VaultView (was stub in plan 01-03)
- editorStore is connected to CMEditor via VaultView openFile flow (was stub in plan 01-03)

## Threat Flags

None -- no new security-relevant surface beyond what the plan's threat model already covers.

## Self-Check: PASSED

**Files verified to exist:**
- FOUND: src/ipc/events.ts
- FOUND: src/components/Progress/ProgressBar.svelte
- FOUND: src/components/Welcome/VaultView.svelte
- FOUND: src/components/Welcome/FileListRow.svelte
- FOUND: src-tauri/src/commands/vault.rs
- FOUND: src-tauri/src/tests/vault_stats.rs
- FOUND: src/types/vault.ts
- FOUND: src/App.svelte
- FOUND: tests/indexProgress.test.ts

**Commits verified via `git log --oneline`:**
- FOUND: 01bca1f feat(01-04): add two-pass walk with progress events + file list return
- FOUND: 5a942eb feat(01-04): add event listener, ProgressBar, and IDX-02 test assertions
- FOUND: 4fb0a2b feat(01-04): wire VaultView, FileListRow, and App.svelte end-to-end

---
*Phase: 01-skeleton*
*Completed: 2026-04-12*
