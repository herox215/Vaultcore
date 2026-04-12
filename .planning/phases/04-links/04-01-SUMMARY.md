---
phase: 04-links
plan: "01"
subsystem: link-graph
tags: [rust, link-graph, ipc, tantivy, watcher, typescript]
dependency_graph:
  requires: []
  provides: [link-graph-backend, link-ipc-commands, link-ts-types]
  affects: [indexer, watcher, frontend-ipc]
tech_stack:
  added: []
  patterns:
    - OnceLock for compiled Regex (replaces once_cell::sync::Lazy)
    - resolve_link 3-stage algorithm (same-folder → shortest-path → alpha)
    - Arc<Mutex<LinkGraph>> in IndexCoordinator (same pattern as file_index)
    - try_send for watcher → IndexCoordinator channel (non-blocking)
    - vault-scope guard: canonicalize + starts_with(vault_root) in rename-cascade
key_files:
  created:
    - src-tauri/src/indexer/link_graph.rs
    - src-tauri/src/commands/links.rs
    - src/types/links.ts
    - src-tauri/src/tests/link_graph.rs
  modified:
    - src-tauri/src/indexer/mod.rs
    - src-tauri/src/watcher.rs
    - src-tauri/src/commands/mod.rs
    - src-tauri/src/commands/vault.rs
    - src-tauri/src/lib.rs
    - src/ipc/commands.ts
    - src-tauri/src/tests/mod.rs
decisions:
  - OnceLock<Regex> used instead of once_cell::sync::Lazy (std library, no extra dep)
  - Watcher receives Option<mpsc::Sender<IndexCmd>> — optional so tests without coordinator still compile
  - resolve_link returns vault-relative paths only (T-04-01)
  - outgoing_for / incoming_for accessor methods added to LinkGraph for IPC commands
  - Pre-existing tabStore.ts TypeScript errors are out-of-scope (pre-date Phase 4)
metrics:
  duration: "9 minutes"
  completed_date: "2026-04-12"
  tasks_completed: 2
  files_changed: 11
---

# Phase 4 Plan 01: LinkGraph Backend Summary

LinkGraph Rust module with Obsidian-compatible 3-stage link resolution, 6 IPC commands (backlinks, outgoing, unresolved, suggest, rename-cascade, resolved-map), TypeScript types and IPC wrappers, and watcher wired for incremental updates on file events.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | LinkGraph module, 3-stage resolution, watcher wiring | a750dc1 | link_graph.rs, indexer/mod.rs, watcher.rs, vault.rs, tests/link_graph.rs, tests/mod.rs |
| 2 | Link IPC commands + frontend types and wrappers | 3cb1d25 | commands/links.rs, commands/mod.rs, lib.rs, link_graph.rs (accessors), types/links.ts, ipc/commands.ts |

## What Was Built

### LinkGraph Module (`src-tauri/src/indexer/link_graph.rs`)

- `extract_links(content: &str) -> Vec<ParsedLink>`: parses `[[target]]` and `[[target|alias]]` using a compiled `OnceLock<Regex>`. Indexes ALL links for graph completeness (code-block exclusion is CM6's responsibility).
- `resolve_link(target_raw, source_folder, all_rel_paths) -> Option<String>`: 3-stage Obsidian algorithm — (1) exact stem match in same folder, (2) shortest path by depth, (3) alphabetical tiebreak.
- `LinkGraph`: adjacency list with `outgoing: HashMap<String, Vec<ParsedLink>>` and `incoming: HashMap<String, Vec<String>>`. `update_file` is idempotent (calls `remove_file` first).
- `resolved_map(all_rel_paths) -> HashMap<String, String>`: stem-to-path map for the frontend click handler, enabling zero-IPC navigation.

### IndexCoordinator Extensions (`src-tauri/src/indexer/mod.rs`)

- `IndexCmd` extended with `UpdateLinks { rel_path, content }` and `RemoveLinks { rel_path }`.
- `IndexCoordinator` gains `link_graph: Arc<Mutex<LinkGraph>>` field and `link_graph()` getter.
- `run_queue_consumer` handles both new variants: `UpdateLinks` locks `file_index` for `all_relative_paths()` then calls `lg.update_file`; `RemoveLinks` calls `lg.remove_file`.
- `index_vault` populates the link graph after indexing all files (two-pass: collect paths, then update graph).

### Watcher Integration (`src-tauri/src/watcher.rs`)

- `spawn_watcher` gains `index_tx: Option<tokio::sync::mpsc::Sender<IndexCmd>>` parameter.
- New `dispatch_link_graph_cmd` function dispatches `UpdateLinks`/`RemoveLinks` per event kind, only for `.md` files.
- Uses `try_send` (non-blocking) — a full channel drops the command rather than blocking the callback thread.
- Write-ignore suppression applies equally to link-graph commands (consistent with Tauri event suppression).
- Rename events dispatch `RemoveLinks(old)` + `UpdateLinks(new, content)`.

### Link IPC Commands (`src-tauri/src/commands/links.rs`)

Six Tauri commands, all following the Arc-clone-before-release pattern from `search.rs`:

1. `get_backlinks(path)` — returns `Vec<BacklinkEntry>` for a target note.
2. `get_outgoing_links(path)` — returns `Vec<ParsedLink>` for a source note.
3. `get_unresolved_links()` — returns all dangling links across the vault.
4. `suggest_links(query, limit)` — nucleo fuzzy match over FileIndex (reuses Phase 3 matcher).
5. `update_links_after_rename(old_path, new_path)` — rewrites wiki-links with vault-scope guard (T-04-01/T-04-02) and write-ignore recording; updates link graph after rewriting.
6. `get_resolved_links()` — returns `HashMap<String, String>` stem→path map.

### TypeScript Layer

- `src/types/links.ts`: `BacklinkEntry`, `UnresolvedLink`, `RenameResult` interfaces (camelCase, matching Rust serde output).
- `src/ipc/commands.ts`: 6 wrapper functions with `normalizeError` pattern. `getResolvedLinks` converts `Record<string, string>` to `Map<string, string>` at call-site.

## Deviations from Plan

### Auto-selected Implementation Choices

**1. [Rule 2 - Missing functionality] Added `outgoing_for` and `incoming_for` accessor methods**
- **Found during:** Task 2
- **Issue:** `commands/links.rs` needs read-only access to `outgoing` and `incoming` maps which are private fields in `LinkGraph`.
- **Fix:** Added `pub fn outgoing_for(&self, source_rel: &str) -> Option<&Vec<ParsedLink>>` and `pub fn incoming_for(&self, target_rel: &str) -> Option<&Vec<String>>` accessor methods.
- **Files modified:** `src-tauri/src/indexer/link_graph.rs`
- **Commit:** 3cb1d25

### Out-of-Scope Issues Found

**Pre-existing `tabStore.ts` TypeScript errors** (logged as deferred):
- `src/store/tabStore.ts` has 4 type errors (`string | undefined` not assignable to `string | null`).
- `src/store/tabStore.test.ts` has 2 errors (`Object is possibly 'undefined'`).
- These pre-date Phase 4 and are unrelated to link changes. No new errors introduced by this plan.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundary crossings introduced. All surfaces are local-only:
- `update_links_after_rename` applies vault-scope guard (T-04-01/T-04-02) before every file operation.
- `resolved_map` returns vault-relative paths only (T-04-04).

## Verification Results

1. `cargo test link_graph` — 18 tests passed (extract_links, resolve_link 3-stage, LinkGraph CRUD, resolved_map).
2. `cargo build --lib` — exits 0, no warnings.
3. `npx tsc --noEmit` — zero errors in new files; 6 pre-existing tabStore errors out of scope.
4. All serde structs use `#[serde(rename_all = "camelCase")]`.
5. TypeScript types in `src/types/links.ts` match Rust struct fields in camelCase.

## Known Stubs

None — all IPC commands are fully wired to the LinkGraph backend.

## Self-Check: PASSED
