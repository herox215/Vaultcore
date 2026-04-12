# Phase 3: Search - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

User can find any note in the vault within tens of milliseconds via either a Tantivy full-text search panel (Cmd/Ctrl+Shift+F) or a fuzzy filename Quick Switcher (Cmd/Ctrl+P), backed by an incremental hash-driven indexer with automatic and manual rebuild capabilities.

**In scope:** IDX-01, IDX-03, IDX-04, IDX-05, IDX-06, IDX-08, IDX-09, SRCH-01, SRCH-02, SRCH-03, SRCH-04, SRCH-05, SRCH-06, ERR-02.

**Explicitly NOT in scope:** Wiki-link parsing/graph/autocomplete (Phase 4), dark mode / remaining shortcuts / polish (Phase 5), performance benchmarks (Phase 6).

</domain>

<decisions>
## Implementation Decisions

### Search Panel Layout
- **D-01:** Full-text search lives in the **left sidebar as a tab**, Obsidian-style. Two tabs at the top of the sidebar: "Dateien" (file tree) and "Suche" (search). Cmd/Ctrl+Shift+F switches directly to the Search tab and focuses the input.
- **D-02:** Search results show **filename + 1-2 line context snippet** with highlighted search term. Result counter at the top (e.g., "23 Treffer in 12 Dateien").
- **D-03:** Search updates **live with ~200ms debounce** as the user types. No Enter required. Tantivy is fast enough (<50ms budget) to support this.

### Quick Switcher UX
- **D-04:** Quick Switcher is a **centered modal in the upper third** of the screen, Obsidian-style. Search field at top, scrollable result list below with filename + relative path. Arrow keys navigate, Enter opens, Escape closes.
- **D-05:** When opened with no input, the Quick Switcher shows **recently opened files** (from tabStore history). Typing switches to fuzzy filename matching.
- **D-06:** Fuzzy matching uses **substring + word-initial matching**. "mn" finds "meeting-notes.md". Matched characters are highlighted (bold) in the results.

### Result Interaction
- **D-07:** Clicking a search result opens the file in a **new tab** (or switches to existing tab if already open) and **scrolls to the match location with a 2-3 second yellow flash-highlight** on the matched text. Highlight fades after the flash.
- **D-08:** Result display is **capped at 100 files**. If more matches exist, show a hint: "Zeige 100 von 342 Treffern — Suche verfeinern".

### Index Rebuild Experience
- **D-09:** Automatic rebuild (schema mismatch / IndexCorrupt) shows a **toast "Index wird neu aufgebaut..." + the existing ProgressBar** (filename + counter, same as initial indexing). Search panel shows "Indexierung lauft..." and is not interactive during rebuild. Completion toast: "Index aktualisiert".
- **D-10:** Manual rebuild trigger is a **button in the search panel header**: "Index neu aufbauen" (refresh icon). Located where the user uses search — contextually logical.
- **D-11:** During any index rebuild (auto or manual), the **editor and file tree remain fully functional**. Only the search panel is disabled. Non-blocking rebuild.

### Claude's Discretion
The following are left for Claude to decide during planning and execution:
- **Tantivy schema design** — field names, tokenizer choice, stored vs. indexed fields, snippet generation strategy.
- **Fuzzy matcher library** — `fuzzy-matcher`, `nucleo`, `sublime_fuzzy`, or hand-rolled. Must meet <10ms budget on 100k filenames.
- **Quick Switcher result limit** — how many results to show before scrolling, max rendered items.
- **Search query syntax help** — whether to show a small hint about AND/OR/NOT/"phrase" syntax in the search panel.
- **Central queue implementation** — channel type (mpsc, crossbeam), queue depth, backpressure strategy.
- **index_version.json schema** — exact fields, version bumping strategy.
- **SHA-256 caching strategy** — where hashes are stored (memory-only vs. sidecar file), eviction on vault close.
- **Tab-leiste visual details** — exact styling of the Dateien/Suche tabs, active/inactive states, icon choices.
- **Flash-highlight styling** — exact yellow shade, animation duration, CSS transition vs. CM6 decoration.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### VaultCore Specification
- `VaultCore_MVP_Spezifikation_v3.md` — Full MVP spec. Relevant sections for Phase 3:
  - Section 6.5 — Volltextsuche (Tantivy full-text search behavior, AND/OR/NOT/phrase syntax, snippets)
  - Section 6.6 — Quick Switcher (fuzzy filename matching, Cmd/Ctrl+P)
  - Section 6.2 — Fortschrittsanzeige (progress UI — reused for rebuild)
  - Section 5 — Error Handling (IndexCorrupt variant, ERR-02 auto-rebuild)
  - Section 9 — Tauri IPC Kommandos (search_fulltext, search_filename, rebuild_index)
  - Section 11 — Rust Backend-Struktur (indexer module)
  - Section 12 — Rust Crate-Abhangigkeiten (tantivy, fuzzy-matcher)
  - Section 14 — Nicht-funktionale Anforderungen (performance budgets: search <50ms, switcher <10ms)
  - Section 17 — Entscheidungslog (Tantivy central queue, index_version.json)

### Planning Artifacts
- `.planning/REQUIREMENTS.md` — IDX-01, IDX-03..06, IDX-08, IDX-09, SRCH-01..06, ERR-02 with acceptance criteria
- `.planning/phases/01-skeleton/01-CONTEXT.md` — Phase 1 decisions: D-21/D-22 (index_progress event facade), D-18 (search module not scaffolded), D-19 (tantivy not in Cargo.toml yet)
- `.planning/phases/02-vault/02-CONTEXT.md` — Phase 2 decisions: D-10 (notify file watcher), D-12 (write-token self-filtering)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/Progress/ProgressBar.svelte` — Reuse for index rebuild progress UI (same component as initial indexing)
- `src/ipc/events.ts` — `listenIndexProgress()` and `INDEX_PROGRESS_EVENT` already wired for `vault://index_progress` events
- `src/ipc/commands.ts` — Typed IPC wrapper pattern. Extend with `searchFulltext`, `searchFilename`, `rebuildIndex` commands
- `src/store/progressStore.ts` — Existing progress state management
- `src/components/Toast/` — Toast surface for rebuild notifications
- `src-tauri/src/error.rs` — `VaultError::IndexCorrupt` variant already exists
- `src-tauri/src/commands/vault.rs` — `open_vault` with file walk facade (Phase 3 replaces walk body with real Tantivy indexing)

### Established Patterns
- **State:** Classic Svelte `writable` stores (Phase 1 D-06). New `searchStore.ts` follows same pattern.
- **IPC:** `invoke<T>("command_name", { args })` with typed wrappers in `src/ipc/commands.ts`. All commands return `Result<T, VaultError>`.
- **Events:** Tauri event system with `vault://` prefix convention. `vault://index_progress` already exists.
- **Error routing:** All errors -> toast surface (unified error UI).
- **Layout:** CSS Grid 3-column sidebar layout with drag-resize (Phase 2). Sidebar content area can host different views via tab switching.

### Integration Points
- `src-tauri/src/commands/vault.rs` — `open_vault` triggers indexing. Phase 3 replaces the walk facade with real Tantivy indexing using the same `vault://index_progress` event channel.
- `src/ipc/events.ts` — Add `listenFileChange` integration: watcher events feed incremental index updates.
- `src/components/Sidebar/` — Currently hosts file tree. Phase 3 adds tab-switching to alternate between file tree and search panel.
- `src/store/tabStore.ts` — Source of recently-opened files for Quick Switcher initial suggestions.
- New Rust modules: `src-tauri/src/indexer/` (Tantivy wrapper, central queue), `src-tauri/src/commands/search.rs` (search_fulltext, search_filename, rebuild_index).
- New frontend: `src/components/Search/` (SearchPanel, SearchResults, QuickSwitcher), `src/store/searchStore.ts`.

</code_context>

<specifics>
## Specific Ideas

- Sidebar tab-switching ("Dateien" / "Suche") should feel instant — no layout shift, no flash. The tab bar sits at the top of the sidebar, search panel and file tree swap underneath.
- Flash-highlight on scroll-to-match should be visually distinct but not garish — a soft warm yellow that fades over 2-3 seconds, not a neon highlight.
- Quick Switcher recents list gives the user immediate value even before they type — the most common action is switching to a recently-edited note.
- German UI text for toasts: "Index wird neu aufgebaut..." and "Index aktualisiert" consistent with Phase 2's German toast convention.
- The search result counter ("23 Treffer in 12 Dateien") gives instant feedback on query quality before scanning individual results.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 03-search*
*Context gathered: 2026-04-12*
