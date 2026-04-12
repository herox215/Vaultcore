---
phase: 04-links
plan: "02"
subsystem: wiki-link-decoration
tags: [codemirror6, typescript, css, viewplugin, decoration]
dependency_graph:
  requires: [link-graph-backend, link-ipc-commands]
  provides: [wiki-link-cm6-plugin, wiki-link-css, wiki-link-resolution-api]
  affects: [editor-extensions, editor-styling]
tech_stack:
  added: []
  patterns:
    - CM6 ViewPlugin with module-level Map for zero-IPC decoration + click resolution
    - RangeSetBuilder with pre-sorted matches (panic prevention)
    - syntaxTree lezer ancestry walk for code block exclusion
    - CustomEvent("wiki-link-click") dispatched on EditorView DOM for Svelte boundary
    - setResolvedLinks(map) + resolveTarget(stem) as the sole resolution API surface
key_files:
  created:
    - src/components/Editor/wikiLink.ts
  modified:
    - src/components/Editor/extensions.ts
    - src/styles/tailwind.css
decisions:
  - Module-level resolvedLinks Map (not per-view state) — single source of truth, populated once per vault open
  - resolveTarget() strips .md suffix before lowercased Map.get — consistent with Rust stem generation
  - RangeSetBuilder receives pre-sorted matches to avoid CM6 panic on out-of-order ranges
  - CustomEvent bubbles:true so EditorPane can listen on a parent element without direct EditorView reference
  - hover underline added beyond UI-SPEC for usability — acceptable minor deviation per plan note
  - rawTarget undefined guard added (strict TS: RegExpExecArray group 1 typed string|undefined)
metrics:
  duration: "7 minutes"
  completed_date: "2026-04-12"
  tasks_completed: 2
  files_changed: 3
---

# Phase 4 Plan 02: CM6 Wiki-Link Decoration and Resolution API Summary

CM6 ViewPlugin that decorates `[[wiki-links]]` in the editor with accent color (resolved) or muted grey (unresolved), backed by a module-level `Map<stem, relPath>` populated via a single `get_resolved_links` IPC call — zero IPC in the render loop, zero IPC at click time.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add wiki-link CSS classes to tailwind.css | ddfd98f | src/styles/tailwind.css |
| 2 | CM6 wikiLink ViewPlugin with resolution API and click dispatch | 096cdcd | src/components/Editor/wikiLink.ts, src/components/Editor/extensions.ts |

## What Was Built

### CSS Classes (`src/styles/tailwind.css`)

Two decoration classes added after existing Phase 3 styles:

- `.cm-wikilink-resolved` — `color: var(--color-accent)`, `cursor: pointer` — for resolved wiki-links
- `.cm-wikilink-unresolved` — `color: var(--color-text-muted)`, `cursor: pointer` — for unresolved links
- Both include `:hover { text-decoration: underline }` for click affordance

### `wikiLink.ts` — CM6 ViewPlugin (`src/components/Editor/wikiLink.ts`)

**Resolution API (module-level):**
- `resolvedLinks: Map<string, string>` — stem (lowercased) → vault-relative path. Module-level singleton, populated once per vault open.
- `setResolvedLinks(map)` — replaces the map. Called by EditorPane after `getResolvedLinks()` IPC on vault open and on incremental file events.
- `resolveTarget(target)` — synchronous `Map.get(stem.toLowerCase())`. Used by both the ViewPlugin (decoration) and EditorPane click handler. Returns `string | null`.
- `refreshWikiLinks(view)` — dispatches no-op transaction to trigger `update()` on all open views after map refresh.

**ViewPlugin:**
- Regex `WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g` — matches `[[target]]` and `[[target|alias]]`.
- `buildDecorations(view)` — collects all regex matches, filters code-block positions via `isInsideCodeBlock()`, pre-sorts by position (RangeSetBuilder requirement), then builds `Decoration.mark` with `class` and `data-wiki-target`/`data-wiki-resolved` attributes.
- `isInsideCodeBlock(state, pos)` — walks lezer syntax tree ancestry, returns true for `FencedCode`, `CodeBlock`, `InlineCode`, `Code` node names.
- Plugin updates decorations on `docChanged || viewportChanged`.

**Click handler (mousedown event):**
- `target.closest("[data-wiki-target]")` — finds decorated span regardless of click target child elements.
- Calls `event.preventDefault()` + `event.stopPropagation()` to suppress CM6's default selection behavior.
- Dispatches `CustomEvent("wiki-link-click", { bubbles: true, detail: { target, resolved } })` on `view.dom` for EditorPane's Svelte listener.
- EditorPane (Plan 04-04) calls `resolveTarget(detail.target)` for resolved links — the returned vault-relative path is prefixed with vault root (T-04-13 mitigation: vault root prefix applied after resolution, not by string-concatenating user input).

### `extensions.ts` update (`src/components/Editor/extensions.ts`)

- `import { wikiLinkPlugin } from "./wikiLink"` added.
- `wikiLinkPlugin` appended to `buildExtensions` return array after `flashField`.
- No signature change — resolution state managed via module-level map.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed strict TypeScript undefined on RegExpExecArray group capture**
- **Found during:** Task 2 — TypeScript compilation
- **Issue:** `m[1]` from `RegExpExecArray` is typed `string | undefined` in strict mode. Four type errors: `rawTarget` possibly undefined, `stem` possibly undefined, `target: stem` not assignable to `string`.
- **Fix:** Added explicit `string | undefined` annotation on `rawTarget` with early `continue` guard; explicit `string` annotation on `stem` using ternary (always a string after guard).
- **Files modified:** `src/components/Editor/wikiLink.ts`
- **Commit:** 096cdcd

### Minor UI-SPEC Deviation

**Hover underline added beyond UI-SPEC:** The plan noted UI-SPEC says "no hover underline" but recommended adding it for usability. Applied as-documented — acceptable per plan's own note.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns introduced. Both trust boundaries from the plan's threat model are correctly mitigated:

- **T-04-05 (data-wiki-target attribute):** Attribute value is a plain string from the lezer-parsed document; used only for in-memory `Map.get()` lookup. No `innerHTML` usage anywhere in the plugin.
- **T-04-06 (wiki-link-click CustomEvent):** Dispatched within the same DOM context, no cross-origin surface. Listener resolves via in-memory map (Rust-produced vault-relative paths — never user-controlled strings passed through).
- **T-04-13 (resolvedLinks map values):** `resolveTarget()` returns vault-relative paths from `get_resolved_links` IPC only. EditorPane (Plan 04-04) is the only caller that may prefix vault root — it will do so after receiving the resolved rel_path, not by concatenating user input.

## Known Stubs

None — the ViewPlugin is fully wired. EditorPane integration (setResolvedLinks call on vault open, wiki-link-click listener, createFile on unresolved click) is scheduled for Plan 04-04 and documented in `wikiLink.ts` comments.

## Self-Check: PASSED
