# Phase 4: Links - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a fully Obsidian-compatible wiki-link system: `[[Note]]` and `[[Note|alias]]` parsing/rendering in CM6, 3-stage shortest-path link resolution, clickable links that open in tabs, backlinks panel, `[[` autocomplete, unresolved-link highlighting, link graph built/maintained incrementally, `get_unresolved_links` command, and rename-cascade that rewrites all links after file rename or move.

Requirements: LINK-01 through LINK-09.

</domain>

<decisions>
## Implementation Decisions

### Backlinks Panel (LINK-06)
- **D-01:** Backlinks live in a **dedicated right sidebar** — a new layout column to the right of the editor. Not a left-sidebar tab, not a bottom panel.
- **D-02:** Right sidebar is **toggled via keyboard shortcut** (e.g., Cmd/Ctrl+Shift+B). Closed by default. Open/closed state persisted across sessions.
- **D-03:** Each backlink entry shows **filename as title + 1-2 lines of context** around the `[[link]]`. Clicking an entry opens that note in the editor.

### Link Autocomplete (LINK-05)
- **D-04:** Autocomplete popup shows **filename (bold) + relative path (grey)** per entry. Helps disambiguate in large vaults with duplicate names.
- **D-05:** Filtering uses **fuzzy matching** (nucleo, same engine as Quick Switcher Cmd+P). Consistent behavior across both features.
- **D-06:** **Alias syntax supported** — after selecting a file, typing `|` allows entering alias freetext. Popup closes on file selection, alias is freehand. Produces `[[Note|alias]]`.

### Unresolved-Link Styling (LINK-04)
- **D-07:** Resolved links rendered in **accent color** (blue/purple, clickable). Unresolved links rendered in **muted/grey color**. Clear visual distinction, Obsidian-compatible.
- **D-08:** Clicking an unresolved link **creates the note** and opens it in a new tab. Obsidian-style "click to create" workflow — natural for Zettelkasten.

### Rename-Cascade (LINK-09)
- **D-09:** Confirmation dialog: **simple "X Links in Y Dateien werden aktualisiert. Fortfahren?"** with [Abbrechen] / [Aktualisieren]. Builds on existing TreeNode confirmation UI.
- **D-10:** Error handling: **partial update + toast**. Successfully rewritten links persist; failed files reported via toast ("X von Y Links aktualisiert. Z Dateien konnten nicht geändert werden."). No rollback.
- **D-11:** Rename-cascade triggers on **both rename and move** (including drag-and-drop). A moved file changes the shortest-path resolution — links must be updated.

### Claude's Discretion
- CM6 extension architecture for wiki-link parsing/decoration (ViewPlugin vs. Decoration approach)
- Link graph data structure in Rust (adjacency list, HashMap, etc.)
- Incremental link graph update strategy on file changes
- `get_unresolved_links` command implementation details
- Right sidebar width, resize behavior, animation

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Specification
- `VaultCore_MVP_Spezifikation_v3.md` — Authoritative spec. Section 6 covers wiki-link resolution (3-stage shortest-path). Section 13 covers keyboard shortcuts. Section 17 is the decision log.

### Prior Phase Context
- `.planning/phases/01-skeleton/01-CONTEXT.md` — Svelte 5 runes, CM6 extension patterns, IPC layer design
- `.planning/phases/02-vault/02-CONTEXT.md` — Sidebar layout, tab system, rename/move/drag-drop flows, file watcher integration
- `.planning/phases/03-search/03-CONTEXT.md` — Search panel in sidebar, nucleo fuzzy matching, scrollStore pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `count_wiki_links` (src-tauri/src/commands/files.rs:420) — regex-based `[[...]]` counter, already used for rename confirmation. Can inform link parsing but full resolution needs a proper parser.
- `FileIndex` (src-tauri/src/indexer/memory.rs) — in-memory index with `all_relative_paths()` and `title` per file. Direct input for autocomplete and link resolution.
- `nucleo` fuzzy matcher — already integrated for Quick Switcher (Phase 3). Reuse for `[[` autocomplete filtering.
- `TreeNode.svelte` — already has rename confirmation dialog with link count display. Extend for the cascade flow.
- `tabStore` — Map-based EditorView lifecycle. Used to open notes in new tabs (link click target).
- `scrollStore` — one-shot cross-component communication pattern. May be useful for "scroll to link" after opening a backlinked note.

### Established Patterns
- CM6 extensions built as explicit extension list (no basicSetup) — Phase 1 decision RC-02
- Svelte 5 runes mode with classic svelte/store for shared state — Phase 1 decision D-06/RC-01
- IPC layer: all Tauri invokes through `src/ipc/commands.ts` with VaultError normalization
- CSS Grid 3-column layout for sidebar/divider/editor — extend to 5-column for right sidebar
- `serde rename_all camelCase` on all IPC result structs

### Integration Points
- Editor: new CM6 extensions for wiki-link decoration, click handling, and `[[` autocomplete trigger
- Layout: extend CSS Grid from 3-column to 5-column (add right divider + right sidebar)
- Rust backend: new link_graph module, link resolution commands, rename-cascade command
- IPC: new commands for resolve_link, get_backlinks, get_unresolved_links, update_links_after_rename
- File watcher: hook into existing watcher to trigger incremental link graph updates

</code_context>

<specifics>
## Specific Ideas

- Autocomplete popup style: filename bold, path grey underneath — modeled after Obsidian's switcher
- Unresolved link click-to-create matches Obsidian's Zettelkasten workflow
- Right sidebar for backlinks (not left sidebar tabs) — keeps file tree and search uncluttered
- Rename-cascade covers both rename AND move/drag-drop operations

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-links*
*Context gathered: 2026-04-12*
