---
phase: 05-polish
plan: "04"
subsystem: tags-ui
tags: [tags, sidebar, search, ui, svelte]
dependency_graph:
  requires: [05-01]
  provides: [tags-panel-ui, tag-click-search, sidebar-three-tabs]
  affects: [src/components/Sidebar/Sidebar.svelte, src/store/searchStore.ts]
tech_stack:
  added: []
  patterns: [classic-writable-store, tdd-red-green, treeitem-aria, svelte5-runes]
key_files:
  created:
    - src/store/tagsStore.ts
    - src/store/__tests__/tagsStore.test.ts
    - src/store/__tests__/searchStore.tagsTab.test.ts
    - src/components/Tags/TagRow.svelte
    - src/components/Tags/TagsPanel.svelte
    - src/components/Tags/__tests__/TagsPanel.test.ts
  modified:
    - src/store/searchStore.ts
    - src/components/Sidebar/Sidebar.svelte
decisions:
  - "tagsStore mirrors backlinksStore loading+error+reload pattern (D-06/RC-01 classic writable)"
  - "buildTree() single-level nesting only — parent/child split on first '/' (D-03)"
  - "Tag-click wires to existing SearchPanel pipeline via setActiveTab('search') + setQuery('#tag') — no new IPC (D-04)"
  - "treeRefreshStore piggyback: tagsStore.reload() added to existing subscriber (no duplicate subscription)"
  - "tagsStore.reset() in onDestroy covers vault-close cleanup (Sidebar unmounts with vault)"
metrics:
  duration: "6min"
  completed: 2026-04-12
  tasks: 3
  files: 8
---

# Phase 5 Plan 04: Tag Panel UI + Third Sidebar Tab + Tag-Click Search Wiring Summary

**One-liner:** Third sidebar "Tags" tab with alphabetical tag list, nested expand/collapse, and tag-click that prefills `#tag` in the existing search pipeline — no new IPC needed.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | tagsStore + searchStore activeTab union | 5607e68 | tagsStore.ts, searchStore.ts, 2 test files |
| 2 | TagsPanel + TagRow components | 3b81892 | TagRow.svelte, TagsPanel.svelte, TagsPanel.test.ts |
| 3 | Sidebar Tags tab + treeRefresh reload | 9d9f317 | Sidebar.svelte |

## What Was Built

### tagsStore (src/store/tagsStore.ts)
Classic writable store with `{ tags: TagUsage[], loading: boolean, error: string | null }`. Exposes `subscribe`, `reload()` (calls `listTags()` IPC, sets loading/error), and `reset()`. Errors surface via `vaultErrorCopy` (German copy, T-02-03 mitigation).

### searchStore extension (src/store/searchStore.ts)
`SearchStoreState.activeTab` widened from `"files" | "search"` to `"files" | "search" | "tags"`. `setActiveTab` signature widened identically. All existing callers remain compatible (they only pass `"files"` or `"search"`).

### TagRow.svelte (src/components/Tags/TagRow.svelte)
Single tag row with:
- `role="treeitem"`, `aria-level`, `aria-expanded` for nested parents
- Chevron button (ChevronRight icon) for expand/collapse on parent rows
- Label button with `#displayName` text + `(count)` badge
- `aria-label="{name} — {N} Notizen"`
- Child rows: `padding-left: 32px` (16px indent per spec)

### TagsPanel.svelte (src/components/Tags/TagsPanel.svelte)
- `buildTree()` groups tags by first `/` segment — single nesting level (D-03)
- Loading, error, empty states (German copy per UI-SPEC Copywriting Contract)
- Empty state: "Keine Tags" heading + "Erstelle Notizen mit #Tags, um sie hier zu sehen." body at 40% from top
- Tag-click: `searchStore.setActiveTab("search")` + `searchStore.setQuery("#" + fullTag)` — SearchPanel's 200ms debounce fires automatically (D-04, TAG-04)
- `role="tree"`, `aria-label="Tags-Bereich"`

### Sidebar.svelte (src/components/Sidebar/Sidebar.svelte)
- Third tab button: Hash icon (14px) + "Tags" label, `aria-label="Tags-Bereich"`
- Tab order: Dateien | Suche | Tags (per D-03 spec)
- `{:else if $searchStore.activeTab === 'tags'}` block mounts `<TagsPanel />` in `vc-sidebar-tabpanel`
- `tagsStore.reload()` called on mount (vault already open)
- `tagsStore.reload()` piggybacked on existing `treeRefreshStore` subscriber (no duplicate subscription)
- `tagsStore.reset()` in `onDestroy` (vault-close cleanup)

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| tagsStore.test.ts | 4 | PASS |
| searchStore.tagsTab.test.ts | 1 | PASS |
| TagsPanel.test.ts | 4 | PASS |
| Full vitest run | 103 | PASS (regression guard) |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. Tag data flows from `listTags()` IPC → `tagsStore.tags` → `buildTree()` → rendered rows. No hardcoded placeholder values.

## Threat Surface Scan

No new network endpoints, auth paths, or cross-boundary trust surfaces introduced. Tag strings are rendered via Svelte text interpolation only — no `{@html}` used anywhere (T-05-04-01 mitigated). T-05-04-02 (large tag count) accepted per plan.

## Self-Check: PASSED

All 5 created/modified files present on disk. All 3 task commits verified in git log.
