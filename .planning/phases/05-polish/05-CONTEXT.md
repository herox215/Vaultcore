# Phase 5: Polish - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning
**Mode:** --auto (all gray areas auto-resolved with recommended options)

<domain>
## Phase Boundary

Transform VaultCore into a polished daily-driver: inline tags + YAML-frontmatter tags with searchable tag panel, runtime dark/light theme toggle, configurable typography (font family + size), full spec-Section-13 keyboard coverage, hash-verify merge path before auto-save, fenced-code-block language highlighting, persistent file-browser sort + expand state, remaining editor niceties (new-note shortcut, undo/redo verified, large-file smoothness).

**Requirements in scope:** TAG-01..04, UI-01, UI-02, UI-03, UI-05, UI-06, EDIT-03, EDIT-07, EDIT-08, EDIT-10, EDIT-11, FILE-06, FILE-07 — 16 total.

**Out of scope:** New features, refactors of already-shipped code, attachments/images, plugin system, graph view, mobile.

</domain>

<decisions>
## Implementation Decisions

### Tags (TAG-01..04)
- **D-01:** Tag extraction lives in a new `src-tauri/src/indexer/tag_index.rs` module. `TagIndex` struct holds `HashMap<String, Vec<TagOccurrence>>` (tag → list of {source_rel_path, line_number}). Inline `#tag` and `#parent/child` extracted via regex from body text. YAML frontmatter parsed via `serde_yaml` (already a common crate; if not in Cargo.toml, add it — YAML-only per D-26).
- **D-02:** TagIndex is in-memory only, rebuilt from disk on cold start (consistent with FileIndex / LinkGraph, D-26 no SQLite). Incremental updates via existing `IndexCmd::UpdateLinks` pattern — extend with `IndexCmd::UpdateTags { rel_path, content }` and `RemoveTags { rel_path }`, wire watcher dispatches (mirror Phase 4 Plan 04-01 pattern).
- **D-03:** Tag panel lives as a **third sidebar tab** ("Tags") next to "Dateien" and "Suche". Tab order: Dateien | Suche | Tags. Panel shows alphabetically-sorted tag list with usage count (e.g., `#rust (12)`). Nested tags (`#a/b`) displayed as tree rows with expand/collapse.
- **D-04:** Tag-click (TAG-04) triggers the existing full-text search: switches to the Search tab, prefills the query with `#tag`, runs `search_fulltext`. No new IPC needed. The `#` prefix is preserved so the search matches the literal token in the note body.

### Themes (UI-01)
- **D-05:** Theme switch via `data-theme="dark|light|auto"` attribute on the `<html>` element. CSS variables in `tailwind.css` defined under `:root[data-theme=light]` (default, keeps current values) and `:root[data-theme=dark]` (new). `auto` mode respects `@media (prefers-color-scheme: dark)`.
- **D-06:** Dark-mode palette is derived from the UI-SPEC's warm off-white neutral + purple accent: dark version = near-black bg (`#1C1C1A`), dark surface (`#2A2A28`), inverted text (`#F5F5F4`), muted grey adjusted, accent kept at `#6D28D9` (WCAG-tested against both bgs). Exact color values locked at plan time.
- **D-07:** Theme preference persisted in localStorage key `vaultcore-theme` (values: `light` / `dark` / `auto`, default `auto`). New `src/store/themeStore.ts` using the `scrollStore`/`treeRefreshStore` writable pattern. CM6 `markdownTheme` already uses CSS variables — no editor rebuild on theme change; DOM attribute flip is enough.

### Typography (UI-02)
- **D-08:** Font family configurable from a fixed curated list (no filesystem font picker for MVP — too platform-sticky):
  - Body: `System UI` (default), `Inter`, `SF Pro`, `Lora` (serif)
  - Mono: `System Mono` (default), `JetBrains Mono`, `Fira Code`
  - Fonts loaded via `@fontsource/*` packages (npm, bundled locally — maintains SEC-01 zero-network). If a font package isn't installed, option is disabled in the UI.
- **D-09:** Font size configurable 12–20px via slider in 1px steps, default 15px (current `markdownTheme` value). Applied via CSS variable `--vc-font-size` set on `<html>`; editor theme reads via `var(--vc-font-size)`.
- **D-10:** Typography + theme live in a new **Settings modal** reached via a Settings (gear) icon button in the **Sidebar topbar** (left side, next to the existing toggle). Modal is a simple centered panel with sections: Theme (3 radio options), Body font (dropdown), Mono font (dropdown), Size (slider), Shortcuts (read-only list).

### Keyboard shortcuts (UI-03, UI-05, EDIT-11)
- **D-11:** Central shortcut registry in `src/lib/shortcuts.ts` — exports a readonly `SHORTCUTS` array of `{ id, keys, label, handler }`. VaultLayout's `handleKeydown` loops this array and dispatches. Makes discoverability trivial (Settings modal reads the same array).
- **D-12:** Missing bindings to wire for spec Section 13:
  - `Cmd/Ctrl+N` → new note (EDIT-11) — creates untitled `.md` in currently-selected folder (fallback: vault root), opens in a new tab with InlineRename focused
  - `Cmd/Ctrl+\` → toggle sidebar (UI-03)
  - Existing: `Cmd+P`, `Cmd+Shift+F`, `Cmd+Shift+B`, `Cmd+Tab`, `Cmd+W`, `Cmd+B/I/K` (bold/italic/link — CM6 defaults)
- **D-13:** Undo/Redo (EDIT-07): already provided by CM6's `history()` extension (Phase 1 decision RC-02). Confirm per-tab isolation — each EditorView has its own history. Add explicit integration test.

### Hash-verify merge (EDIT-08, EDIT-10)
- **D-14:** Before every auto-save, the auto-save extension computes the on-disk SHA-256 hash and compares against the hash VaultCore recorded at last successful read/write. On mismatch, the write is **cancelled** and the Phase 2 three-way-merge engine (SYNC-06..08) is invoked with {local buffer, on-disk content, expected-hash's last content}. Result merged back into the CM6 doc via existing toast notifications.
- **D-15:** Expected-hash tracking: `tabStore` already has `originalHash` per tab from the initial read; `autoSave` extension updates it after each successful write. No new storage needed.
- **D-16:** No-size-limit confirmation (EDIT-08): add an integration test that opens a 10,000-line fixture and asserts no degradation (keystroke latency stays < 16ms over 100 keystrokes). CM6 handles this natively (Phase 1 decision) — the test is a regression guard, not new code.

### Fenced code highlighting (EDIT-03)
- **D-17:** Use CM6's `@codemirror/language-data` for lazy-loading language packs by fence label. Top-10 pre-registered: `js`, `ts`, `rust`, `python`, `go`, `html`, `css`, `bash`, `json`, `yaml`. `markdown({ codeLanguages })` config accepts the lookup function.
- **D-18:** Fallback for unrecognized language labels: monospace-only rendering (no syntax colors) — matches current fence behavior.

### File browser persistence (FILE-06, FILE-07)
- **D-19:** Sort order (name / modified / created) and folder expand/collapse state persisted per-vault in localStorage, keyed by vault path: `vaultcore-tree-state:<sha256(vault_path)>`. Structure: `{ sortBy: "name"|"modified"|"created", expanded: string[] (rel paths) }`.
- **D-20:** Sort control UI: a small sort icon button in the sidebar topbar (next to the Tags tab selector), opens a 3-option menu. Default: `name` ascending. Folders always listed before files.

### Toast / dialog unification (UI-06)
- **D-21:** Audit pass — scan every error surface (`toastStore.push`), rename prompt, merge-notice and verify all use the existing unified toast component (Phase 1 UI-04). Extract any inline `alert()` or `confirm()` calls into toast/dialog. No new UI needed, just cleanup.

### Claude's Discretion
- Exact dark-mode color hex values (derived from UI-SPEC brand palette)
- Settings-modal layout + visual treatment (keep minimal, Obsidian-inspired)
- `tag_index.rs` internal data structure tuning
- Whether to cache the settings modal's font dropdown state in memory vs. localStorage
- Exact keyboard-handling priority (e.g., when both Cmd+N in modal and Cmd+N in sidebar fire)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Specification
- `VaultCore_MVP_Spezifikation_v3.md` — Section 7 perf budgets, Section 13 keyboard shortcuts table, Section 17 decision log (D-26 no-SQLite, YAML-only)

### Prior Phase Context
- `.planning/phases/01-skeleton/01-CONTEXT.md` — Svelte 5 runes, CM6 explicit extension list, toast unified
- `.planning/phases/02-vault/02-CONTEXT.md` — sidebar tabs, tree state patterns, SYNC-06..08 merge engine (base for EDIT-10)
- `.planning/phases/03-search/03-CONTEXT.md` — sidebar tab pattern (Dateien/Suche — add Tags as third), `search_fulltext` IPC (tag-click target)
- `.planning/phases/04-links/04-CONTEXT.md` — right sidebar + toggle button patterns; for Settings gear icon follow same lucide-svelte convention
- `.planning/phases/04.1-phase-4-uat-bugfixes/04.1-CONTEXT.md` — tree refresh pattern (signal store), tab reload pattern (signal store) — reuse for tag index refresh

### Source files to extend
- `src-tauri/src/indexer/mod.rs` — IndexCoordinator extends with tag_index Arc<Mutex<TagIndex>>
- `src-tauri/src/indexer/link_graph.rs` — pattern template for tag_index.rs
- `src-tauri/src/watcher/mod.rs` — UpdateTags/RemoveTags dispatch, mirror the UpdateLinks pattern
- `src/styles/tailwind.css` — add `:root[data-theme=dark]` variable set
- `src/components/Editor/theme.ts` — CM6 theme already uses CSS vars, verify hook-in
- `src/components/Editor/extensions.ts` — `markdown({ codeLanguages })` for EDIT-03
- `src/components/Editor/autoSave.ts` — add hash-verify before write (EDIT-10)
- `src/components/Layout/VaultLayout.svelte` — handleKeydown routes via shortcuts.ts, add Settings gear, Cmd+\ toggle
- `src/components/Sidebar/Sidebar.svelte` — add Tags tab next to Dateien/Suche
- `src/merge.ts` / Phase 2 merge engine path — plug-in point for EDIT-10

### New files expected
- `src-tauri/src/indexer/tag_index.rs` — Rust tag storage
- `src-tauri/src/commands/tags.rs` — IPC: `list_tags`, `get_tag_occurrences`
- `src/types/tags.ts` — TagOccurrence, TagUsage types
- `src/components/Tags/TagsPanel.svelte` — tag list UI
- `src/components/Settings/SettingsModal.svelte` — theme + font + shortcut overview
- `src/store/themeStore.ts` — data-theme attribute manager
- `src/store/settingsStore.ts` — font family / size persistence
- `src/lib/shortcuts.ts` — central shortcut registry

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scrollStore` / `treeRefreshStore` / `tabReloadStore` — signal-store pattern for cross-component one-shot events; reuse for tag-index refresh events
- `link_graph.rs` — template for `tag_index.rs` (regex extraction, incremental update, IPC surface)
- CM6 `markdownTheme` in `theme.ts` — already uses CSS variables; theme switch requires zero editor rebuild
- Existing three-way merge engine (Phase 2 SYNC-06..08) — consume for EDIT-10 hash-verify path, no new merge logic
- nucleo matcher (Phase 3) — available if we want fuzzy tag filtering in the tag panel
- `@fontsource/*` npm packages — zero-network font loading
- lucide-svelte icons — already used for panel-right; Settings (`Settings` or `Gear`) icon, Tags (`Hash` or `Tag`) icon fit the same convention

### Established Patterns
- Three-column (now five-column) CSS Grid layout in VaultLayout — stays
- Settings modal: follow the Welcome screen's modal/dialog treatment for visual consistency
- Regex fast-path (`content.contains(literal)` before `regex.is_match`) — use in tag_index.rs like link_graph.rs
- `serde rename_all camelCase` on IPC result structs
- localStorage keys prefixed with `vaultcore-` — `vaultcore-theme`, `vaultcore-font-body`, etc.
- Auto-save extension ViewPlugin (Phase 1) — augment with hash-verify, don't rewrite

### Integration Points
- VaultLayout handleKeydown → shortcuts.ts registry
- Sidebar tab strip → add Tags tab (third)
- IndexCoordinator → add tag_index Arc, register `UpdateTags`/`RemoveTags` commands
- tabStore → originalHash tracking already there, just needs wiring to hash-verify in autoSave
- Existing merge toast variants (clean-merge, conflict) → reused for EDIT-10

</code_context>

<specifics>
## Specific Ideas

- Settings modal design inspired by Obsidian's minimal settings panel — left nav list of sections, right content panel, but collapsed into a single scroll view for MVP simplicity
- Dark-mode palette: keep the warm neutral spirit of light mode — `#1C1C1A` (warm near-black) as bg, `#2A2A28` surface, `#F5F5F4` text, `#A8A8A5` muted grey, accent stays `#6D28D9`
- Auto-save hash verify: the existing 2s debounce means one hash computation per 2s — negligible CPU cost, well within budgets

</specifics>

<deferred>
## Deferred Ideas

- **Custom theme editor** — JSON-theme import/plugin system lives in v0.2 PLUG-01
- **Tag autocomplete while typing** — could trigger a popup like wiki-links; useful but not in scope (tags are identified by body text, not explicit syntax gate like `[[`)
- **Tag rename cascade** — same conceptual fix as LINK-09 but across tags; complex, not in any REQ-ID, deferred
- **Bundled font variants (all weights)** — MVP ships with 400+700 only, more weights = more bundle size

</deferred>

---

*Phase: 05-polish*
*Context gathered: 2026-04-12 via /gsd-discuss-phase --auto*
