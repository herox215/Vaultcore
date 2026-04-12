---
phase: 01-skeleton
plan: 03
subsystem: editor
tags: [codemirror6, svelte5, autosave, keymap, markdown-highlighting]

# Dependency graph
requires:
  - phase: 01-skeleton/00
    provides: vitest + testing-library-svelte scaffolds, empty component dirs, CSS variables in src/styles/tailwind.css, it.todo stubs for keymap/autoSave
  - phase: 01-skeleton/01
    provides: Rust backend IPC (read_file, write_file) and VaultError serialization
  - phase: 01-skeleton/02
    provides: editorStore (activePath, content, lastSavedHash), IPC commands wrapper, ToastContainer mounted in App.svelte
provides:
  - CMEditor.svelte component with EditorView lifecycle (onMount/onDestroy)
  - RC-02 explicit CM6 extension list via buildExtensions(onSave)
  - wrapSelection helper + vaultKeymap (Mod-B/I/K) with toggle-off behavior
  - autoSaveExtension factory (2000ms idle debounce on docChanged)
  - markdownTheme + markdownHighlightStyle using CSS variables for Phase 5 dark mode swap
affects: [01-04-progress-filelist-wireup, 02-files, 04-links, 05-polish]

# Tech tracking
tech-stack:
  added:
    - "@codemirror/autocomplete (explicit dep)"
    - "@lezer/markdown (explicit dep)"
  patterns:
    - "RC-02: Explicit CM6 extension list — no basicSetup, no lineNumbers, no foldGutter"
    - "RC-01: EditorView stored in plain let, NOT $state — avoids Svelte Proxy breaking CM6 internals"
    - "wrapSelection as StateCommand factory with changeByRange for multi-cursor support"
    - "autoSaveExtension as pure factory with EditorView.updateListener.of — no module-level singleton"
    - "CSS variable references in CM6 theme for Phase 5 dark mode swap"

key-files:
  created:
    - src/components/Editor/keymap.ts
    - src/components/Editor/autoSave.ts
    - src/components/Editor/theme.ts
    - src/components/Editor/CMEditor.svelte
  modified:
    - src/components/Editor/extensions.ts
    - tests/keymap.test.ts
    - tests/autoSave.test.ts
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "RC-02 enforced: buildExtensions uses 13 explicit extensions, no basicSetup"
  - "RC-01 enforced: EditorView in plain let with explicit comment explaining why"
  - "autoSaveExtension uses EditorView.updateListener (not ViewPlugin) for simplicity"
  - "indentWithTab included in keymap for Tab key indentation support"
  - "H4/H5/H6 heading sizes included in HighlightStyle (16px/15px/15px) for completeness"

patterns-established:
  - "CM6 StateCommand factory pattern for keymap bindings (wrapSelection returns a StateCommand)"
  - "CM6 extension factory pattern for side-effect extensions (autoSaveExtension returns Extension)"
  - "Svelte 5 component with CM6: bind:this for container, onMount for EditorView creation, onDestroy for cleanup"

requirements-completed: [EDIT-01, EDIT-02, EDIT-04, EDIT-09]

# Metrics
duration: ~4min
completed: 2026-04-12
---

# Phase 1 Plan 3: Editor + Auto-Save Summary

**RC-02-locked explicit CM6 extension list with Markdown+GFM live-preview, wrapSelection keymap with toggle-off for Mod-B/I/K, 2000ms idle-debounce autoSave, and a Svelte 5 CMEditor wrapper storing EditorView in a plain let (RC-01) -- ready for plan 01-04 to mount in the VaultView.**

## Performance

- **Duration:** ~4 minutes
- **Started:** 2026-04-12T05:50:41Z
- **Completed:** 2026-04-12T05:55:07Z
- **Tasks:** 3 (all TDD -- test + impl bundled)
- **Files created:** 4
- **Files modified:** 5

## Accomplishments

- `wrapSelection` helper implements toggle-off behavior: Mod-B on `**foo**` removes the markers, Mod-I on `*foo*` does the same. Uses CM6 `changeByRange` for multi-cursor support. `wrapLink` (Mod-K) inserts `[text](url)` with cursor positioned inside the URL placeholder.
- `autoSaveExtension` is a pure factory returning a CM6 `updateListener` extension. 2000ms idle debounce, resets on successive keystrokes, ignores selection-only transactions. No module-level singleton state.
- `markdownHighlightStyle` renders H1 at 26px, H2 at 22px, H3 at 18px (all weight 700) per UI-SPEC. Bold gets weight 700, italic gets font-style italic, inline code gets monospace font family with light gray background. All colors reference CSS variables.
- `markdownTheme` sets accent cursor color, accent-bg selection, 720px max-width content area with auto-centered margins, 15px base font size, and transparent active-line highlight.
- `buildExtensions` assembles the RC-02-locked explicit extension list: history, drawSelection, dropCursor, indentOnInput, bracketMatching, closeBrackets, highlightActiveLine, lineWrapping, keymap (closeBracketsKeymap + defaultKeymap + historyKeymap + indentWithTab + vaultKeymap), markdown with GFM, syntaxHighlighting, markdownTheme, and autoSaveExtension.
- `CMEditor.svelte` mounts EditorView in `onMount` into a `bind:this` container, stores it in a plain `let` (not `$state`, per RC-01), and destroys it in `onDestroy`. Props interface: `{ content: string, onSave: (text: string) => void }`.
- All Wave 0 `it.todo` stubs in `keymap.test.ts` (6 tests) and `autoSave.test.ts` (4 tests) upgraded to real passing assertions. Total suite: 31 passed, 2 todo (indexProgress stubs for plan 01-04).

## Task Commits

1. **Task 1: keymap.ts + wrapSelection + vaultKeymap + EDIT-04 tests** -- `141a65c` (feat)
2. **Task 2: autoSave.ts + 2000ms debounce + EDIT-09 tests** -- `6709b86` (feat)
3. **Task 3: theme.ts + extensions.ts (RC-02) + CMEditor.svelte** -- `112f4b3` (feat)

## Files Created/Modified

- `src/components/Editor/keymap.ts` -- wrapSelection, wrapLink, vaultKeymap (Mod-B/I/K)
- `src/components/Editor/autoSave.ts` -- autoSaveExtension factory, 2000ms debounce
- `src/components/Editor/theme.ts` -- markdownHighlightStyle + markdownTheme using CSS variables
- `src/components/Editor/CMEditor.svelte` -- Svelte 5 wrapper, EditorView in plain let
- `src/components/Editor/extensions.ts` -- RC-02 explicit buildExtensions function (was stub)
- `tests/keymap.test.ts` -- 6 EDIT-04 assertions (was it.todo)
- `tests/autoSave.test.ts` -- 4 EDIT-09 assertions (was it.todo)
- `package.json` / `pnpm-lock.yaml` -- added @codemirror/autocomplete, @lezer/markdown as explicit deps

## Decisions Made

- **RC-02 enforced exactly as specified** -- 13 explicit extensions, no basicSetup import anywhere in src/components/Editor/
- **RC-01 enforced with explanatory comment** -- `let view: EditorView | null = null` with a comment explaining that `$state` would break CM6's internal change detection via Svelte's reactive Proxy
- **EditorView.updateListener chosen over ViewPlugin for autoSave** -- simpler API, sufficient for the idle-debounce use case, and the plan explicitly suggested it
- **indentWithTab added to keymap** -- improves editing ergonomics without conflicting with any locked decision
- **H4-H6 heading sizes added to HighlightStyle** -- plan only required H1-H3 but adding reasonable fallbacks (16px/15px/15px) prevents unstyled headings

## Deviations from Plan

None -- plan executed exactly as written. Every acceptance criterion met on first pass:

- `pnpm vitest run` -- 31 passed / 2 todo (keymap: 6, autoSave: 4, vault: 9, Toast: 6, WelcomeScreen: 6)
- `pnpm typecheck` -- exits 0
- `pnpm build` -- exits 0, 127 modules transformed
- `cargo build --manifest-path src-tauri/Cargo.toml` -- exits 0 (unaffected)
- `basicSetup` appears only in the RC-02 decision comment, not as import or function call
- `lineNumbers`/`foldGutter` appear only in the RC-02 decision comment
- `$state(new EditorView` -- 0 matches (RC-01 enforced)

## Issues Encountered

None.

## Known Stubs

| Stub | File | Line(s) | Reason | Resolved by |
|------|------|---------|--------|-------------|
| CMEditor not mounted in any view | src/components/Editor/CMEditor.svelte | entire file | Plan 01-04 mounts CMEditor inside VaultView and wires onSave to writeFile IPC | plan 01-04 |
| editorStore not connected to CMEditor | src/store/editorStore.ts | entire file | Plan 01-04 bridges editorStore.openFile to CMEditor content prop | plan 01-04 |

## User Setup Required

None.

## Next Phase Readiness

- **Plan 01-04 (progress + file list wire-up) is unblocked** -- CMEditor.svelte exists with a clean `{ content, onSave }` prop interface. Plan 01-04 mounts it inside a VaultView, wires `onSave` to `writeFile`, and connects `editorStore.openFile` to drive content.
- **No open blockers for the rest of Phase 1.**

## Self-Check: PASSED

**Files verified to exist:**
- FOUND: src/components/Editor/keymap.ts
- FOUND: src/components/Editor/autoSave.ts
- FOUND: src/components/Editor/theme.ts
- FOUND: src/components/Editor/CMEditor.svelte
- FOUND: src/components/Editor/extensions.ts
- FOUND: tests/keymap.test.ts (upgraded)
- FOUND: tests/autoSave.test.ts (upgraded)

**Commits verified via `git log --oneline`:**
- FOUND: 141a65c feat(01-03): add wrapSelection helper + vaultKeymap (Mod-B/I/K) with toggle-off
- FOUND: 6709b86 feat(01-03): add autoSaveExtension with 2000ms idle debounce on docChanged
- FOUND: 112f4b3 feat(01-03): add CM6 theme, RC-02 extension list, and CMEditor.svelte wrapper

---
*Phase: 01-skeleton*
*Completed: 2026-04-12*
