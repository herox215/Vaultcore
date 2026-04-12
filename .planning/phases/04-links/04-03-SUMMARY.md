---
phase: 04-links
plan: "03"
subsystem: wiki-link-autocomplete
tags: [codemirror6, typescript, css, autocomplete, ipc, nucleo]
dependency_graph:
  requires: [link-graph-backend, link-ipc-commands]
  provides: [wiki-link-autocomplete-cm6]
  affects: [editor-extensions, editor-styling]
tech_stack:
  added: []
  patterns:
    - CM6 CompletionSource (async) with filter:false for backend-side fuzzy ranking
    - autocompletion({ override }) to replace default CM6 completion sources
    - matchBefore regex gating for [[, ]], and | (alias boundary, D-06)
    - suggestLinks IPC (nucleo) reused from Quick Switcher for consistent fuzzy behavior
key_files:
  created:
    - src/components/Editor/wikiLinkAutocomplete.ts
  modified:
    - src/components/Editor/extensions.ts
    - src/styles/tailwind.css
decisions:
  - filter:false used because nucleo already ranks results; CM6 re-filtering would break nucleo ordering
  - apply includes ]] so a single selection produces a complete [[Filename]]
  - Alias boundary check (innerText.includes("|")) causes CompletionSource to return null — popup does not reopen after | (D-06)
  - autocompletion() placed after closeBrackets() in extension array, consistent with plan order
metrics:
  duration: "68 seconds"
  completed_date: "2026-04-12"
  tasks_completed: 1
  files_changed: 3
---

# Phase 4 Plan 03: Wiki-Link Autocomplete Summary

CM6 CompletionSource that fires on `[[`, queries the Rust nucleo fuzzy matcher via `suggestLinks` IPC, and inserts `[[Filename]]` on selection — styled per UI-SPEC with 360px popup, filename bold + path grey, accent highlight on active row.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wiki-link CompletionSource with fuzzy matching | af025b1 | src/components/Editor/wikiLinkAutocomplete.ts, src/components/Editor/extensions.ts, src/styles/tailwind.css |

## What Was Built

### `wikiLinkAutocomplete.ts` — CM6 CompletionSource

**Trigger logic:**
- `ctx.matchBefore(/\[\[([^\]]*/)` — fires only inside an open `[[`
- Early return if `]]` immediately follows cursor (already-complete link guard)
- Early return if `innerText.includes("|")` — user is typing alias freehand (D-06)

**Query and results:**
- Calls `suggestLinks(query, 20)` IPC backed by nucleo fuzzy matcher (D-05, same engine as Quick Switcher Cmd+P)
- `filter: false` — backend already ranked results; CM6 must not re-filter with its own algorithm
- Each `Completion` has `label: basename(r.path)`, `detail: r.path` (grey path, D-04), `apply: "${basename}]]"` (inserts closing brackets), `boost: r.score`

**Empty state:**
- When backend returns 0 results, returns a single non-interactive entry with `label: "Keine Dateien gefunden"` and `apply: query` (keeps typed text)

**Helper:**
- `basename(path)` strips directory components and `.md` suffix to produce the plain filename stem

### `extensions.ts` update

- `autocompletion` added to the `@codemirror/autocomplete` import line
- `wikiLinkCompletionSource` imported from `./wikiLinkAutocomplete`
- `autocompletion({ override: [wikiLinkCompletionSource], activateOnTyping: true, defaultKeymap: true })` added after `closeBrackets()` in `buildExtensions` return array

### `tailwind.css` additions

Autocomplete popup styling per UI-SPEC:
- `.cm-tooltip-autocomplete`: 360px width, 320px max-height, `--color-surface` background, border + border-radius + box-shadow
- `.cm-tooltip-autocomplete ul li`: 8px 16px padding, min-height 44px, flex column (filename over path)
- `[aria-selected="true"]`: `--color-accent-bg` background, accent label color
- `.cm-completionLabel`: 14px / 600 weight / `--color-text`
- `.cm-completionDetail`: 12px / 400 weight / `--color-text-muted`, `margin-left: 0 !important` (overrides CM6 default)

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced.

Both threat register entries correctly accepted:
- **T-04-07 (Information Disclosure):** Popup shows only vault-relative filenames returned from the Rust backend. No user-controlled data is rendered as HTML.
- **T-04-08 (DoS / rapid IPC):** CM6 `autocompletion()` debounces internally. Each new keystroke supersedes the prior async result. `suggestLinks` uses nucleo which runs sub-10ms at 100k files.

## Known Stubs

None — the CompletionSource is fully wired to the `suggestLinks` IPC and the CM6 extension is registered in `buildExtensions`.

## Self-Check: PASSED
