---
phase: 03-search
plan: "04"
subsystem: search-ui
tags: [svelte, quick-switcher, flash-highlight, cm6, keyboard-nav, scroll-to-match, nucleo]

requires:
  - phase: 03-search
    plan: "02"
    provides: searchFilename IPC wrapper, FileMatch type
  - phase: 03-search
    plan: "03"
    provides: SearchPanel, VaultLayout keydown handler, tabStore

provides:
  - QuickSwitcher.svelte: Cmd/Ctrl+P modal, recents from tabStore, fuzzy filename match, keyboard nav
  - QuickSwitcherRow.svelte: per-char match highlighting (bold+accent color for matched indices)
  - flashHighlight.ts: flashEffect StateEffect, flashField StateField, scrollToMatch(), extractSnippetMatch()
  - scrollStore.ts: one-shot scroll request coordinator between SearchPanel and EditorPane
  - EditorPane.svelte: scrollStore subscription, inline text search, scrollToMatch on result click
  - SearchPanel.svelte: result click triggers scrollStore.requestScrollToMatch with snippet match text

affects:
  - src/components/Layout/VaultLayout.svelte (Cmd+P wiring, QuickSwitcher render)
  - src/components/Editor/extensions.ts (flashField added to all EditorViews)
  - src/styles/tailwind.css (vc-quick-switcher-*, vc-flash-highlight, vc-flash-done)

tech-stack:
  added: []
  patterns:
    - One-shot scrollStore coordinates cross-component scroll requests without prop drilling
    - inline doc.toString().indexOf() for text search (no @codemirror/search dep needed)
    - requestAnimationFrame triggers CSS transition after decoration paint for smooth fade
    - flashEffect.of(null) after 2600ms removes decoration cleanly after 2500ms CSS transition
    - QuickSwitcher uses $effect to reset state on open and focus input via tick()
    - tabStore subscription in QuickSwitcher builds recents list (last 8 unique filePaths reversed)

key-files:
  created:
    - src/components/Search/QuickSwitcher.svelte (modal overlay, keyboard nav, recents, fuzzy results)
    - src/components/Search/QuickSwitcherRow.svelte (per-char match highlighting)
    - src/components/Editor/flashHighlight.ts (flashEffect, flashField, scrollToMatch, extractSnippetMatch)
    - src/store/scrollStore.ts (one-shot scroll request coordinator)
  modified:
    - src/components/Layout/VaultLayout.svelte (Cmd+P handler, QuickSwitcher import and render)
    - src/components/Editor/extensions.ts (flashField added to buildExtensions)
    - src/components/Editor/EditorPane.svelte (scrollStore subscription, scrollToMatch execution)
    - src/components/Search/SearchPanel.svelte (result click triggers scrollStore request)
    - src/styles/tailwind.css (vc-quick-switcher-*, vc-flash-highlight, vc-flash-done CSS)

key-decisions:
  - "scrollStore one-shot pattern: coordinator store avoids prop-drilling EditorPane viewMap to SearchPanel"
  - "inline string search instead of @codemirror/search: SearchCursor not available (package not installed); doc.toString().indexOf() is equivalent for first-occurrence search"
  - "extractSnippetMatch parses first <b>...</b> from Tantivy snippet for scroll target text"
  - "QuickSwitcher auto-focus via $effect + tick() — runs on every open, resets state cleanly"

metrics:
  duration: 4min
  completed: 2026-04-12
  tasks: 3
  files: 9
---

# Phase 3 Plan 04: Quick Switcher + Flash Highlight Summary

**Cmd/Ctrl+P Quick Switcher modal with fuzzy filename matching, keyboard navigation, and CM6 flash highlight for scroll-to-match on search result clicks**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-12T14:44:28Z
- **Completed:** 2026-04-12
- **Tasks:** 3 (Task 1: QuickSwitcher modal, Task 2: flash highlight + result wiring, Task 3: checkpoint auto-approved)
- **Files modified/created:** 9

## Accomplishments

- Created `QuickSwitcher.svelte`: centered modal (role=dialog, aria-modal, Schnellwechsler label), shows last 8 recently opened files from tabStore on empty input ("Zuletzt geöffnet"), calls `searchFilename(query, 20)` with no debounce on input, ArrowUp/Down/Enter/Escape keyboard nav, focus trap on Tab, backdrop click to close, auto-focuses input on open via `$effect` + `tick()`
- Created `QuickSwitcherRow.svelte`: per-character match highlighting — chars at `matchIndices` positions rendered in `font-weight:700` and `var(--color-accent)`; filename and relative path lines per spec
- Created `flashHighlight.ts`: `flashEffect` (StateEffect), `flashField` (StateField with `EditorView.decorations.from(f)`), `scrollToMatch()` (scroll + decoration + rAF fade + 2600ms cleanup), `extractSnippetMatch()` (regex parse of Tantivy `<b>...</b>` snippet)
- Created `scrollStore.ts`: one-shot coordinator store — `requestScrollToMatch(filePath, searchText)` sets pending request; EditorPane subscribes, finds first occurrence via `doc.toString().indexOf()`, calls `scrollToMatch()`, then `clearPending()`
- Updated `VaultLayout.svelte`: `Cmd/Ctrl+P` opens `quickSwitcherOpen`, `<QuickSwitcher>` rendered at template root outside the grid
- Updated `extensions.ts`: `flashField` included in `buildExtensions()` so all EditorView instances carry the flash decoration state
- Updated `EditorPane.svelte`: subscribes to `scrollStore`, resolves tab from filePath, finds text offset, calls `scrollToMatch()`
- Updated `SearchPanel.svelte`: `handleResultClick` extracts snippet match text and calls `scrollStore.requestScrollToMatch()`
- Added Phase 3 CSS to `tailwind.css`: `vc-quick-switcher-backdrop`, `vc-quick-switcher-modal`, `vc-flash-highlight` (yellow BG + 2500ms fade), `vc-flash-done` (transparent)

## Task Commits

1. **Task 1: Quick Switcher modal** — `b81c0a6` (feat)
2. **Task 2: CM6 flash highlight + scroll-to-match wiring** — `679c279` (feat)
3. **Task 3: Human-verify checkpoint** — auto-approved (auto_advance=true)

## Files Created/Modified

- `/home/sokragent/Projects/vaultcore/src/components/Search/QuickSwitcher.svelte` — modal, recents, fuzzy search, keyboard nav
- `/home/sokragent/Projects/vaultcore/src/components/Search/QuickSwitcherRow.svelte` — per-char highlight row
- `/home/sokragent/Projects/vaultcore/src/components/Editor/flashHighlight.ts` — CM6 flash decoration + scrollToMatch
- `/home/sokragent/Projects/vaultcore/src/store/scrollStore.ts` — one-shot scroll request coordinator
- `/home/sokragent/Projects/vaultcore/src/components/Layout/VaultLayout.svelte` — Cmd+P handler, QuickSwitcher render
- `/home/sokragent/Projects/vaultcore/src/components/Editor/extensions.ts` — flashField in buildExtensions
- `/home/sokragent/Projects/vaultcore/src/components/Editor/EditorPane.svelte` — scrollStore subscription, scroll execution
- `/home/sokragent/Projects/vaultcore/src/components/Search/SearchPanel.svelte` — result click triggers scrollStore
- `/home/sokragent/Projects/vaultcore/src/styles/tailwind.css` — quick switcher + flash highlight CSS

## Decisions Made

- **scrollStore one-shot pattern:** SearchPanel has no direct access to EditorPane's `viewMap`. Rather than prop-drilling or making viewMap global, a one-shot coordinator store decouples the two — SearchPanel writes the request, EditorPane reads and executes it, then clears it. Clean separation of concerns.
- **Inline string search (no @codemirror/search):** The plan specified `SearchCursor` from `@codemirror/search`, but that package is not installed in this project. Using `doc.toString().indexOf()` with case-insensitive lowercasing achieves equivalent first-occurrence behavior for MVP. Can be upgraded to SearchCursor if the package is added in a later phase.
- **extractSnippetMatch uses first `<b>` tag:** Tantivy SnippetGenerator wraps matched terms in `<b>` tags. The first tagged term is the best scroll target. Fallback: use first word of query if no `<b>` found.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] @codemirror/search package not installed**
- **Found during:** Task 2 (import of SearchCursor)
- **Issue:** Plan spec called for `SearchCursor` from `@codemirror/search`, but the package is not in `node_modules`. Importing it would cause a runtime module resolution failure.
- **Fix:** Replaced `SearchCursor` usage with inline `doc.toString().indexOf()` (case-insensitive). This finds the first occurrence of the matched text in the document — functionally equivalent for MVP use cases where the search term is a plain word/phrase.
- **Files modified:** `src/components/Editor/EditorPane.svelte` (removed SearchCursor import, inline string search)
- **Verification:** `npx tsc --noEmit` passes with zero new errors
- **Committed in:** `679c279`

## Checkpoint: Auto-Approved

**Task 3** was a `checkpoint:human-verify` gate. Auto-approved per `auto_advance=true` configuration. The full Phase 3 manual verification checklist (15 steps) was not run — requires `pnpm tauri dev` with a real vault.

## Known Stubs

None — all components wire to live data (searchFilename IPC, tabStore recents, CM6 flash decoration). Quick Switcher results open real tabs via `tabStore.openTab()`.

## Threat Flags

No new threat surface beyond what was declared in the plan's threat_model:
- T-03-11 (DoS via rapid searchFilename): accepted — no debounce, nucleo <10ms per spec
- T-03-12 (Tampering via flash decoration): accepted — hardcoded CSS class, no user content

---
*Phase: 03-search*
*Completed: 2026-04-12*
