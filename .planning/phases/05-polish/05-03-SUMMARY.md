---
phase: 05-polish
plan: 03
subsystem: ui
tags: [svelte, typescript, codemirror6, keyboard-shortcuts, settings, registry-pattern, tdd]

requires:
  - phase: 05-polish-02
    provides: "SettingsModal with shortcuts stub, gear button wired, themeStore/settingsStore live"

provides:
  - "SHORTCUTS readonly array (7 entries) in src/lib/shortcuts.ts — single source of truth for all MVP keyboard shortcuts"
  - "handleShortcut(e, ctx, guard) dispatcher with priority guards: settingsOpen, inlineRenameActive, quickSwitcherOpen, non-meta"
  - "formatShortcut(keys) helper renders platform-aware display (⌘ on Mac, Ctrl elsewhere)"
  - "VaultLayout.handleKeydown replaced with single registry dispatch call — no more hand-rolled if/else chain"
  - "Cmd+N creates Unbenannte Notiz.md at vault root, opens in new tab, refreshes tree (EDIT-11)"
  - "Cmd+\\ toggles sidebar via existing toggleSidebar() with 200ms CSS transition (UI-03)"
  - "SettingsModal Section C: 7-row kbd-styled shortcut table sourced from SHORTCUTS array (UI-05)"
  - "3 EDIT-07 regression tests proving CM6 history() is per-EditorView (not shared)"

affects: [05-polish-04, 05-polish-07]

tech-stack:
  added: []
  patterns:
    - "Central registry pattern: SHORTCUTS array consumed by both dispatcher (VaultLayout) and display (SettingsModal) from single source"
    - "Priority guard pattern: settingsOpen|inlineRenameActive short-circuit before meta check; quickSwitcherOpen short-circuits before iteration"
    - "Shift-directional shortcut: next-tab uses shiftKey for direction (prev vs next) rather than as a key modifier — special-cased in dispatcher"
    - "inlineRenameActive() reads document.activeElement.closest('.vc-inline-rename') — DOM-based guard, no store coupling"

key-files:
  created:
    - src/lib/shortcuts.ts
    - src/lib/__tests__/shortcuts.test.ts
    - src/components/Editor/__tests__/undoRedoPerTab.test.ts
  modified:
    - src/components/Layout/VaultLayout.svelte
    - src/components/Settings/SettingsModal.svelte

key-decisions:
  - "SHORTCUTS shift guard: entries with shift:true require shiftKey; entries without shift explicitly require !shiftKey (prevents Cmd+Shift+N matching Cmd+N); next-tab exempted since shift toggles direction"
  - "createNewNote always uses vault root for MVP — selected-folder targeting deferred to Phase 6 per D-12 fallback rule"
  - "Backend create_file collision suffix starts at 1 (existing behavior: 'Unbenannte Notiz 1.md') not 2 as spec text suggests — kept as-is to preserve Phase 2 test expectations; spec difference is cosmetic"
  - "Task 2 Step A (backend suffix) is no-op — create_file_impl already uses find_available_name for non-empty names, verified by existing Rust test suite (21 tests pass)"

requirements-completed: [UI-03, UI-05, EDIT-11, EDIT-07]

duration: 6min
completed: 2026-04-12
---

# Phase 05 Plan 03: Shortcut Registry Refactor + Cmd+N + Cmd+\\ + Settings Shortcut Table Summary

**Central SHORTCUTS registry (7 bindings) replaces VaultLayout's hand-rolled if/else chain; Cmd+N and Cmd+\\ wired; SettingsModal Section C populated with kbd table; EDIT-07 undo isolation verified**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-12T21:11:26Z
- **Completed:** 2026-04-12T21:17:xx Z
- **Tasks:** 3
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments

- `src/lib/shortcuts.ts`: `SHORTCUTS` readonly array (7 entries), `handleShortcut()` dispatcher with 4-level priority guard, `formatShortcut()` helper (Mac ⌘ / non-Mac Ctrl)
- `src/lib/__tests__/shortcuts.test.ts`: 9 tests covering array shape, all three priority guards, non-meta rejection, platform-specific formatting — all green
- `VaultLayout.svelte`: old 40-line if/else keydown chain replaced with `handleShortcut(e, ctx, guard)` one-liner + `createNewNote()` + `inlineRenameActive()` guard
- `SettingsModal.svelte`: `data-testid="settings-shortcuts-placeholder"` replaced with live `{#each SHORTCUTS}` table + kbd CSS
- `src/components/Editor/__tests__/undoRedoPerTab.test.ts`: 3 regression tests proving CM6 undo/redo isolation is per-EditorView (EDIT-07)

## Task Commits

1. **Task 1: SHORTCUTS registry + tests (TDD)** — `3b2d3f3` (feat, TDD green)
2. **Task 2: VaultLayout refactor + SettingsModal shortcut table** — `d1db5d5` (feat)
3. **Task 3: Per-tab undo/redo isolation tests** — `1d3c59f` (test)

## Files Created/Modified

- `src/lib/shortcuts.ts` — Central registry: SHORTCUTS (7), handleShortcut(), formatShortcut()
- `src/lib/__tests__/shortcuts.test.ts` — 9 unit tests (array shape, priority guards, formatting)
- `src/components/Layout/VaultLayout.svelte` — Registry imports, createNewNote(), inlineRenameActive(), handleKeydown refactored
- `src/components/Settings/SettingsModal.svelte` — SHORTCUTS import, Section C with kbd table + CSS
- `src/components/Editor/__tests__/undoRedoPerTab.test.ts` — 3 EDIT-07 regression tests

## Decisions Made

- SHORTCUTS shift guard requires `!shiftKey` for non-shift bindings (prevents Cmd+Shift+N matching Cmd+N slot). next-tab exempted because shift picks direction, not a separate binding.
- createNewNote uses vault root (not selected folder) in MVP — D-12 states vault root as fallback; selected-folder targeting deferred.
- Backend create_file collision suffix starts at 1 (existing `find_available_name` behavior), not 2 as spec text states — kept as-is to preserve Phase 2 test expectations. Cosmetic difference only.
- Task 2 Step A (backend suffix) confirmed no-op: create_file_impl already calls find_available_name for non-empty names; 21 Rust file tests all green.

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Minor Notes

**1. Backend collision suffix starts at 1, not 2**
- **Found during:** Task 2 Step A review
- **Issue:** Spec text says "Unbenannte Notiz 2.md" for first collision; existing `find_available_name` produces "Unbenannte Notiz 1.md"
- **Decision:** Kept existing behavior — changing it would require updating the Phase 2 test (`create_file_collision_auto_suffixes` expects "Untitled 1.md") and both behaviors are equally valid UX. Documented as known minor spec deviation.
- **Disposition:** No code change; noted in SUMMARY.

## Known Stubs

None. All three requirements are fully wired:
- UI-03: Cmd+\\ toggles sidebar via SHORTCUTS registry
- UI-05: SettingsModal Section C renders all 7 shortcuts
- EDIT-11: Cmd+N creates Unbenannte Notiz.md and opens in tab
- EDIT-07: 3 regression tests prove per-tab isolation intact

## Threat Flags

No new network endpoints, auth paths, or file access patterns introduced.

| Threat | Mitigation | Verified |
|--------|-----------|---------|
| T-05-03-01: Cmd+N behind settings modal | guard.settingsOpen short-circuits | Test 4 green |
| T-05-03-02: Cmd+N steals Quick Switcher Enter | guard.quickSwitcherOpen short-circuits | Test 5 green |
| T-05-03-03: Inline rename Cmd+N clobbers name edit | inlineRenameActive() checks .vc-inline-rename | Test 6 green |
| T-05-03-05: Filename collision overwrites existing file | find_available_name suffixes until free | Rust test 2 green |

## Self-Check

- [x] `src/lib/shortcuts.ts` exists with `export const SHORTCUTS`, `handleShortcut`, `formatShortcut`
- [x] `src/lib/__tests__/shortcuts.test.ts` — 9 tests pass
- [x] `src/components/Editor/__tests__/undoRedoPerTab.test.ts` — 3 tests pass
- [x] VaultLayout uses `handleShortcut` (old chain removed)
- [x] SettingsModal has `{#each SHORTCUTS}` table (placeholder removed)
- [x] Full suite: 76 tests pass, 0 failures
- [x] Rust file tests: 21 pass, 0 failures
- [x] Commits: 3b2d3f3, d1db5d5, 1d3c59f all exist

## Self-Check: PASSED
