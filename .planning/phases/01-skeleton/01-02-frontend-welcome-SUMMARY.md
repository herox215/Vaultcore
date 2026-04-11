---
phase: 01-skeleton
plan: 02
subsystem: ui
tags: [svelte, svelte-stores, tauri-ipc, testing-library-svelte, tailwind-vars]

# Dependency graph
requires:
  - phase: 01-skeleton/00
    provides: vitest + testing-library-svelte scaffolds, empty component dirs, CSS variables in src/styles/tailwind.css, it.todo stubs for vault/Toast/WelcomeScreen
  - phase: 01-skeleton/01
    provides: Rust backend IPC (open_vault, get_recent_vaults, get_vault_stats, read_file, write_file) and VaultError {kind, message, data} serialization
provides:
  - Typed IPC wrapper layer (src/ipc/commands.ts) — sole importer of @tauri-apps/api/core invoke
  - Four classic writable stores (vaultStore, editorStore, toastStore, progressStore) per D-06/RC-01
  - VaultError discriminated union mirroring Rust serialized shape + isVaultError guard + vaultErrorCopy map
  - Toast component with three variants (error/conflict/clean-merge) — UI-04 unified error surface
  - WelcomeScreen with UI-SPEC layout, empty state, recent vault list
  - App.svelte auto-load-last-vault flow with VAULT-05 fallback
  - 21 Vitest assertions (9 vault + 6 Toast + 6 WelcomeScreen)
affects: [01-03-editor-autosave, 01-04-progress-filelist-wireup, 02-files, 05-polish]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Classic Svelte writable stores exposed as { subscribe, ...actions } object (D-06/RC-01)"
    - "All Tauri invoke calls funnel through src/ipc/commands.ts with normalizeError coercion (T-02-01, T-02-02)"
    - "VaultError IPC shape validated at boundary by isVaultError type guard"
    - "Static vaultErrorCopy map — no raw path interpolation in toast copy (T-02-03)"
    - "CSS-variable-only styling in components so Phase 5 dark-mode swap is a drop-in"
    - "Component callback props (onOpenVault, onPickVault, onOpen) — no bidirectional event bubbling"
    - "testing-library/svelte rendering with data-testid hooks for component tests"

key-files:
  created:
    - src/types/errors.ts
    - src/types/vault.ts
    - src/ipc/commands.ts
    - src/store/vaultStore.ts
    - src/store/editorStore.ts
    - src/store/toastStore.ts
    - src/store/progressStore.ts
    - src/components/Toast/Toast.svelte
    - src/components/Toast/ToastContainer.svelte
    - src/components/Welcome/WelcomeScreen.svelte
    - src/components/Welcome/RecentVaultRow.svelte
  modified:
    - src/App.svelte
    - tests/vault.test.ts
    - tests/Toast.test.ts
    - tests/WelcomeScreen.test.ts

key-decisions:
  - "Frontend VaultError interface mirrors Rust serialized shape {kind, message, data: string | null} exactly — normalizeError coerces err.data?? null to keep data non-undefined"
  - "toastStore exposes a test-only _reset() for deterministic test isolation (T-02-E accepted risk per threat register)"
  - "RecentVaultRow renders last_opened as truncated ISO date (slice before T) — Phase 5 will swap for relative-time formatter"
  - "App.svelte passes empty fileList to vaultStore.setReady() — plan 01-04 feeds the real walk results via vault://index_progress events"
  - "$state([]) used only for component-local recent array in App.svelte (not a Zustand-equivalent store); D-06/RC-01 ban applies only to src/store/ class wrappers"

patterns-established:
  - "IPC wrapper try/catch normalizeError — every command wraps invoke<T> and coerces thrown errors to VaultError"
  - "Store action object — private writable + named methods, never a raw writable exported"
  - "Component callback props using Svelte 5 $props() destructuring with explicit types"
  - "role=status + aria-live=polite on toast cards for screen reader announcement"

requirements-completed: [VAULT-01, VAULT-02, VAULT-03, VAULT-04, VAULT-05, UI-04]

# Metrics
duration: ~12min
completed: 2026-04-11
---

# Phase 1 Plan 2: Frontend Welcome Summary

**Typed Tauri IPC layer, four classic svelte/store writables, UI-SPEC Welcome card with recent-vault list, three-variant Toast surface, and App.svelte auto-load-last-vault flow with VAULT-05 fallback — wired end-to-end on top of Wave 1's Rust backend.**

## Performance

- **Duration:** ~12 minutes
- **Started:** 2026-04-11T20:29:00Z
- **Completed:** 2026-04-11T20:41:16Z
- **Tasks:** 3 (all TDD — test + impl bundled)
- **Files created:** 11
- **Files modified:** 4

## Accomplishments

- Frontend now has a complete, type-safe bridge to every Wave 1 Rust command through `src/ipc/commands.ts` — no component ever touches `invoke` directly, enforcing the T-02-01 "no bypass of vault-scope guard" mitigation at the codebase level.
- `VaultError` discriminated union in `src/types/errors.ts` exactly mirrors the Rust serialized shape (`kind`/`message`/`data`) and ships with `isVaultError` runtime validation plus a `vaultErrorCopy` map that never interpolates raw filesystem paths (T-02-03).
- Four classic Svelte `writable` stores (`vaultStore`, `editorStore`, `toastStore`, `progressStore`) with typed action objects — no `$state` class wrappers, satisfying the D-06 / RC-01 lock for Phase 1.
- Toast component renders all three UI-04 variants (`error`/`conflict`/`clean-merge`) with the correct border colors, icons (`✕`/`⚠`/`✓`), ARIA roles, 5000ms auto-dismiss, and 3-toast FIFO cap.
- WelcomeScreen matches the UI-SPEC card layout (`max-width: 480px`, `48px/32px` padding, `8px` radius, subtle shadow), uses only CSS variables, and swaps between the empty state and a scrollable recent-vault list driven by a typed `recent` prop.
- `App.svelte` auto-loads the most recent reachable vault on mount (VAULT-03) and cleanly falls back to Welcome + an error toast when the vault is unreachable (VAULT-05) — no crash, no broken state.
- All three Wave 0 `it.todo` test files upgraded to real assertions: 21 green Vitest cases total (9 vault + 6 Toast + 6 WelcomeScreen), other Wave-0 todos preserved.

## Task Commits

1. **Task 1: Types + IPC wrappers + four Svelte writable stores** — `c282410` (feat)
2. **Task 2: Toast component + ToastContainer + Toast.test.ts** — `27a49c6` (feat)
3. **Task 3: WelcomeScreen + App.svelte auto-load flow + WelcomeScreen.test.ts** — `245b4da` (feat)

_TDD per task: test and implementation bundled into a single commit because the plan specified a single acceptance-criteria gate per task (rather than split RED → GREEN commits)._

## Files Created/Modified

- `src/types/errors.ts` — `VaultErrorKind`, `VaultError`, `isVaultError`, `vaultErrorCopy`
- `src/types/vault.ts` — `VaultInfo`, `VaultStats`, `RecentVault`, `VaultStatus`
- `src/ipc/commands.ts` — `pickVaultFolder`, `openVault`, `getRecentVaults`, `getVaultStats`, `readFile`, `writeFile` (sole `invoke` importer)
- `src/store/vaultStore.ts` — lifecycle store (`idle` → `opening` → `ready|error`) with action object
- `src/store/editorStore.ts` — editor state store scaffold (activePath, content, lastSavedHash)
- `src/store/toastStore.ts` — cap-at-3 FIFO queue with 5000ms auto-dismiss and `_reset` test hook
- `src/store/progressStore.ts` — scaffold for plan 01-04 progress events
- `src/components/Toast/Toast.svelte` — variant card, ARIA live region, manual dismiss
- `src/components/Toast/ToastContainer.svelte` — fixed bottom-right stack
- `src/components/Welcome/WelcomeScreen.svelte` — UI-SPEC card layout
- `src/components/Welcome/RecentVaultRow.svelte` — RTL-truncated path row with ISO date suffix
- `src/App.svelte` — onMount auto-load flow, status-based render, mounted ToastContainer
- `tests/vault.test.ts` — 9 assertions (vaultStore lifecycle + toastStore queue)
- `tests/Toast.test.ts` — 6 assertions (all three variants, auto-dismiss, cap eviction)
- `tests/WelcomeScreen.test.ts` — 6 assertions (heading, tagline, empty state, populated list, CTA click, row click)

## Decisions Made

- **Classic writable stores over Svelte 5 `$state` class wrappers** — D-06/RC-01 is locked for Phase 1. Each store exports an action object `{ subscribe, ...methods }` so call sites never see the raw writable.
- **`$state([])` used only for the component-local `recent` array in App.svelte** — the D-06 ban targets cross-component store machinery, not local component reactivity. This is the correct Svelte 5 idiom for `onMount` setting a local array consumed by the child `WelcomeScreen`.
- **`vaultErrorCopy` returns hardcoded copy strings, never interpolates paths** — prevents `/etc/...` style absolute paths from leaking into toast text (T-02-03).
- **App.svelte feeds empty `fileList` on ready** — plan 01-04 is the owner of the real file walk via the `vault://index_progress` event channel. The placeholder file count comes from `VaultInfo.file_count` returned by `open_vault`.
- **`recent` is refreshed via `getRecentVaults()` after every successful `loadVault`** — keeps the recent list in sync with the Rust-side persistence so when the user navigates back to Welcome they see the updated order.
- **RecentVaultRow renders ISO date prefix (YYYY-MM-DD) rather than full ISO timestamp** — more readable and matches the UI-SPEC "Label role (12px/400), muted color" intent without pulling in a relative-time formatter. Phase 5 can replace `formatTimestamp` with `"2 days ago"` style.

## Deviations from Plan

None — plan executed exactly as written. Every acceptance criterion in the plan's `<acceptance_criteria>` blocks was met on first pass, and every check in the top-level `<verification>` block passes:

- `pnpm vitest run` → 21 passed / 10 todo preserved (expected ≥21 passed)
- `pnpm typecheck` → exits 0 under strict mode
- `pnpm build` → exits 0, 127 modules transformed
- `cargo build --manifest-path src-tauri/Cargo.toml` → exits 0 (unaffected, as expected for a frontend-only plan)
- `grep -rE "invoke\(" src/components/ src/App.svelte` → no matches (T-02-01)
- `grep -rE "\$state\(" src/store/` → no matches (RC-01 / D-06)
- `grep -rE "(cdn\.|googleapis\.com|http://|https://)" src/components/ src/App.svelte` → no matches (T-06 / SEC-01)
- `grep -c "invoke<" src/ipc/commands.ts` → 5 (meets "≥5" criterion)

## Issues Encountered

None.

## Known Stubs

These are intentional scaffolds — each will be filled in by a later plan explicitly scoped for it. They are NOT broken state and do not prevent VAULT-01..05 and UI-04 from working end-to-end.

| Stub | File | Line(s) | Reason | Resolved by |
|------|------|---------|--------|-------------|
| Placeholder `vault-view` div (replaces real file list + editor when `status === "ready"`) | src/App.svelte | ~78–83 | Editor (plan 01-03) and file list (plan 01-04) are out of scope for 01-02 per the prompt | plans 01-03 and 01-04 |
| `vaultStore.setReady({ ..., fileList: [] })` — empty file list | src/App.svelte | ~35 | File walk and progress events are owned by plan 01-04 | plan 01-04 (consumes `vault://index_progress` events) |
| `RecentVaultRow.formatTimestamp` returns raw ISO date prefix | src/components/Welcome/RecentVaultRow.svelte | ~13–16 | Relative-time formatting deferred to Phase 5 per UI-SPEC | Phase 5 polish |
| `progressStore` has no event-channel wiring | src/store/progressStore.ts | entire file | Store shape is scaffolded here so plan 01-04 only writes the Tauri event listener, not the store | plan 01-04 |
| `editorStore` has no CM6 wiring | src/store/editorStore.ts | entire file | Plan 01-03 mounts CodeMirror on top of this store | plan 01-03 |

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 01-03 (editor + autosave) is unblocked** — `editorStore` shape is committed, `readFile`/`writeFile` IPC wrappers are ready, `ToastContainer` is mounted in App.svelte so autosave error paths can surface immediately.
- **Plan 01-04 (progress + file list wire-up) is unblocked** — `progressStore` is scaffolded, the App.svelte placeholder `vault-view` div is the exact mount point for the real file list + editor host, and `vaultStore.setReady` already accepts the `fileList` parameter that plan 01-04 will populate.
- **No open blockers for Wave 3.** The frontend compiles, tests pass, and the Rust backend is unaffected.

## Self-Check: PASSED

**Files verified to exist:**
- FOUND: src/types/errors.ts
- FOUND: src/types/vault.ts
- FOUND: src/ipc/commands.ts
- FOUND: src/store/vaultStore.ts
- FOUND: src/store/editorStore.ts
- FOUND: src/store/toastStore.ts
- FOUND: src/store/progressStore.ts
- FOUND: src/components/Toast/Toast.svelte
- FOUND: src/components/Toast/ToastContainer.svelte
- FOUND: src/components/Welcome/WelcomeScreen.svelte
- FOUND: src/components/Welcome/RecentVaultRow.svelte
- FOUND: src/App.svelte (modified)
- FOUND: tests/vault.test.ts (upgraded)
- FOUND: tests/Toast.test.ts (upgraded)
- FOUND: tests/WelcomeScreen.test.ts (upgraded)

**Commits verified via `git log --oneline -5`:**
- FOUND: c282410 feat(01-02): add typed IPC layer, four writable stores, VaultError copy map
- FOUND: 27a49c6 feat(01-02): add Toast and ToastContainer components with UI-04 variants
- FOUND: 245b4da feat(01-02): add WelcomeScreen, RecentVaultRow and App.svelte auto-load flow

---
*Phase: 01-skeleton*
*Completed: 2026-04-11*
