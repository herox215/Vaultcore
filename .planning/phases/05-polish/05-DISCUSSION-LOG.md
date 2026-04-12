# Phase 5: Polish - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-12
**Phase:** 05-polish
**Mode:** --auto (all gray areas auto-resolved; user did not enter interactive discussion)

---

## Tag Storage

| Option | Description | Selected |
|--------|-------------|----------|
| New TagIndex in-memory (like FileIndex/LinkGraph) | Rebuilt from disk on start, incremental via IndexCmd | ✓ |
| SQLite table | Durable across restarts, but contradicts D-26 | |
| File-based sidecar | Portable but slow to refresh | |

**Auto-selected:** In-memory pattern — matches D-26 and prior phase conventions.

---

## Tag Panel Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Third sidebar tab ("Tags") | Consistent with Dateien/Suche pattern from Phase 3 | ✓ |
| Right sidebar tab alongside Backlinks | Consolidates metadata panels | |
| Inline expandable section in file tree | No new tab needed, less discoverable | |

**Auto-selected:** Third tab — matches established Phase 3 pattern, discoverable.

---

## Theme Switch Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| `data-theme` attribute on `<html>` + CSS variable swap | No rebuild needed, CSS-only | ✓ |
| Separate CSS bundles loaded dynamically | Clean but slow to switch | |
| Inline style injection | Flexible but harder to maintain | |

**Auto-selected:** data-theme attribute — zero-rebuild, CM6 theme already uses variables.

---

## Font Config UX

| Option | Description | Selected |
|--------|-------------|----------|
| Settings modal (gear icon) | New modal, contains theme + font + shortcuts | ✓ |
| Inline dropdown in sidebar header | Compact but clutters sidebar | |
| Command-palette style picker | Powerful but MVP has no command palette (out of scope per PROJECT.md) | |

**Auto-selected:** Settings modal — natural home for multiple user-preference settings.

---

## Shortcut Registry

| Option | Description | Selected |
|--------|-------------|----------|
| Central `src/lib/shortcuts.ts` array | Single source of truth, easy to document in Settings | ✓ |
| Distributed across components | Current state, hard to discover | |

**Auto-selected:** Central registry — enables Settings modal to display the full list.

---

## Hash-Verify Merge Path

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse Phase 2 three-way-merge engine (SYNC-06..08) | Already-tested, matches spec | ✓ |
| New lightweight diff | Less code path for this specific case | |

**Auto-selected:** Reuse merge engine — consistent with spec, no parallel codepath.

---

## File Browser Persistence

| Option | Description | Selected |
|--------|-------------|----------|
| Per-vault localStorage key | Each vault is a different workspace | ✓ |
| Global settings (all vaults share) | Simpler but less useful | |
| Write to vault `.vaultcore/state.json` | Portable with vault, adds FS ops | |

**Auto-selected:** Per-vault localStorage — matches existing `vaultcore-sidebar-width` pattern.

---

## Fenced Code Highlighting

| Option | Description | Selected |
|--------|-------------|----------|
| CM6 `@codemirror/language-data` lazy-load, top-10 languages | Balanced bundle size + coverage | ✓ |
| Ship all CM6 languages eagerly | Large bundle, fast switches | |
| Monospace-only (defer EDIT-03) | Would miss a REQ-ID | |

**Auto-selected:** Top-10 lazy-load — balances bundle size with practical coverage.

---

## Tag-Click Search

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse `search_fulltext` with `#tag` query | No new IPC, consistent with existing search | ✓ |
| New `search_by_tag` IPC | Faster but duplicates infrastructure | |

**Auto-selected:** Reuse full-text search — simpler, consistent.

---

## Claude's Discretion

- Exact dark-mode color hex values (derived from UI-SPEC brand palette)
- Settings-modal layout + visual treatment (keep minimal, Obsidian-inspired)
- `tag_index.rs` internal data structure tuning
- Keyboard-handling priority when shortcuts overlap (e.g., Cmd+N in modal vs sidebar)

## Deferred Ideas

- Custom theme editor (v0.2 PLUG-01)
- Tag autocomplete popup while typing
- Tag rename cascade (no REQ-ID)
- Bundled font weights beyond 400+700
