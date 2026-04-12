---
phase: 05-polish
plan: 02
subsystem: ui
tags: [svelte, tailwind, css-variables, dark-mode, theming, typography, settings-modal]

requires:
  - phase: 05-polish-00
    provides: "@fontsource/* deps installed, theme.ts uses var(--vc-font-size)"
  - phase: 05-polish-01
    provides: "TagIndex backend complete"

provides:
  - "Dark palette declared under :root[data-theme=dark] with 11 CSS variables (locked UI-SPEC hex)"
  - ":root[data-theme=auto] inside @media (prefers-color-scheme: dark) mirrors dark palette"
  - "--vc-font-size: 14px CSS variable in :root (producer for Plan 00's theme.ts consumer)"
  - "themeStore: validates against VALID_THEMES whitelist (T-05-02-01), persists to localStorage"
  - "settingsStore: BODY_STACKS/MONO_STACKS whitelist (T-05-02-02), clampSize 12-20 (T-05-02-03)"
  - "SettingsModal.svelte: German copy, 3 theme radios, body/mono dropdowns, size slider, shortcuts stub"
  - "Gear button in VaultLayout editor topbar opens Settings modal"
  - "App.svelte calls themeStore.init() + settingsStore.init() before first paint"

affects: [05-polish-03, 05-polish-07]

tech-stack:
  added: []
  patterns:
    - "vi.stubGlobal('localStorage', mockMap) for tests in jsdom environments where window.localStorage.clear() is unavailable (Tauri webdriver localStorage override)"
    - "Classic writable factory pattern for theme/settings stores (D-06/RC-01 locked — no $state runes)"
    - "Whitelist-before-DOM-write pattern: always validate user-controlled values against a constant before any CSS property or dataset mutation"

key-files:
  created:
    - src/store/themeStore.ts
    - src/store/settingsStore.ts
    - src/components/Settings/SettingsModal.svelte
    - src/lib/__tests__/themeStore.test.ts
    - src/lib/__tests__/settingsStore.test.ts
  modified:
    - src/styles/tailwind.css
    - src/components/Layout/VaultLayout.svelte
    - src/App.svelte

key-decisions:
  - "vi.stubGlobal('localStorage', ...) required in tests — jsdom's window.localStorage.clear() is undefined due to Tauri's --localstorage-file override injected into the jsdom environment"
  - "vi.resetModules() in beforeEach allows fresh store import per test without module-level state leaking between tests"
  - "SettingsModal uses $props() + subscribe side-effects (not $derived) to keep store coupling compatible with D-06/RC-01 classic store pattern"

patterns-established:
  - "Theme store: VALID_THEMES whitelist constant + isValidTheme guard before any dataset.theme write"
  - "Settings store: BODY_STACKS/MONO_STACKS record maps token → CSS stack; only the mapped value is written to CSS (never raw user input)"
  - "Font size: clampSize() enforces [12,20] range + NaN guard; test both floor and ceiling"

requirements-completed: [UI-01, UI-02]

duration: 11min
completed: 2026-04-12
---

# Phase 05 Plan 02: Theme System + Dark Palette + Settings Modal Summary

**Dark/light/auto CSS variable palette + validated themeStore/settingsStore + SettingsModal with German copy wired end-to-end into VaultLayout and App.svelte**

## Performance

- **Duration:** 11 min
- **Started:** 2026-04-12T20:56:14Z
- **Completed:** 2026-04-12T21:07:44Z
- **Tasks:** 2
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments

- Dark palette (11 CSS variables under `:root[data-theme=dark]`) + auto mode under `@media (prefers-color-scheme: dark)` + `--vc-font-size: 14px` default in `:root`
- `themeStore` + `settingsStore` with whitelist validation (T-05-02-01, T-05-02-02, T-05-02-03) — 8 tests green
- `SettingsModal.svelte` (213 LoC, German copy) with theme radio group, font dropdowns, size slider, and Plan-03 shortcut stub
- Gear button added to VaultLayout editor topbar; `themeStore.init()` + `settingsStore.init()` wired in `App.svelte` `onMount` before first paint

## Task Commits

1. **Task 1: Dark palette + --vc-font-size var + themeStore + settingsStore** — `5b0bc5f` (feat, TDD green)
2. **Task 2: SettingsModal + gear button + App.svelte init** — `0be2506` (feat)

## Files Created/Modified

- `src/styles/tailwind.css` — Added `--vc-font-size: 14px` to `:root`; new `[data-theme=light/dark]` and `@media auto` blocks
- `src/store/themeStore.ts` — Runtime theme switching with VALID_THEMES whitelist, localStorage persistence
- `src/store/settingsStore.ts` — Font body/mono/size with BODY_STACKS/MONO_STACKS whitelists and clampSize
- `src/components/Settings/SettingsModal.svelte` — Full Settings modal with German sections Erscheinungsbild + Schrift + Tastaturkürzel stub
- `src/components/Layout/VaultLayout.svelte` — SettingsIcon import, settingsOpen state, gear button in topbar, SettingsModal rendered at body level
- `src/App.svelte` — themeStore/settingsStore imports + init calls at top of onMount
- `src/lib/__tests__/themeStore.test.ts` — 4 tests (init, set, whitelist rejection, default)
- `src/lib/__tests__/settingsStore.test.ts` — 4 tests (setFontSize, clamp, whitelist rejection, init with stored values)

## Decisions Made

- `vi.stubGlobal('localStorage', mockMap)` required — jsdom's `window.localStorage.clear()` is `undefined` because Tauri's webdriver injects a `--localstorage-file`-based localStorage override that has no `clear` method; workaround is a Map-backed mock stub per test
- `vi.resetModules()` in `beforeEach` gives each test a fresh module instance so store singleton state doesn't leak between tests
- SettingsModal uses classic `subscribe` side-effects (not `$derived`) to stay compatible with D-06/RC-01 writable store pattern

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Replaced `localStorage.clear()` with `vi.stubGlobal` mock in tests**
- **Found during:** Task 1 (TDD RED/GREEN cycle)
- **Issue:** `localStorage.clear is not a function` in jsdom — Tauri webdriver's `--localstorage-file` override replaces the standard `Storage` interface with a custom object missing `clear`/`setItem`/`getItem`
- **Fix:** Created `setupLocalStorage()` helper that stubs `window.localStorage` with a `Map`-backed implementation having all standard methods
- **Files modified:** `src/lib/__tests__/themeStore.test.ts`, `src/lib/__tests__/settingsStore.test.ts`
- **Verification:** All 8 tests pass; `vi.stubGlobal` does not affect production code
- **Committed in:** `5b0bc5f` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in test environment interaction)
**Impact on plan:** Fix was necessary to achieve green tests. Production store code unchanged. No scope creep.

## Issues Encountered

- `--localstorage-file` Tauri warning in jsdom environment causes standard `localStorage` methods to be unavailable; diagnosed by inspecting `Object.getOwnPropertyNames` on the storage object

## Known Stubs

- `src/components/Settings/SettingsModal.svelte`: `data-testid="settings-shortcuts-placeholder"` — shortcut table section is intentionally empty per plan spec; Plan 03 fills it in after the shortcut registry is built. This stub does not prevent the plan's goal (UI-01/UI-02) from being achieved.

## Threat Flags

No new network endpoints, auth paths, or file access patterns introduced. All new surface is confined to `localStorage` reads/writes (already in threat model T-05-02-01..03, mitigated by whitelists).

## Next Phase Readiness

- UI-01 (dark/light/auto toggle) and UI-02 (font family + size) fully wired and persisting
- Settings modal gear button is live; Plan 03 can drop shortcut table into the `data-testid="settings-shortcuts-placeholder"` section
- `--vc-font-size` CSS var now has a producer (`:root`) so Plan 00's `theme.ts` consumer works correctly

---
*Phase: 05-polish*
*Completed: 2026-04-12*
