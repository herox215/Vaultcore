# VaultCore

## What This Is

A local, Markdown-first note and knowledge-management desktop app positioned as a faster Obsidian alternative. VaultCore is built for power users whose vaults have grown past the point where Obsidian starts to lag (≈100,000+ notes) and who want to keep their files as plain Markdown on disk — no proprietary format, no cloud, no telemetry.

## Core Value

**Stay fluid at 100,000+ notes.** Open, search, link, and edit a vault of that size without perceptible lag. If this fails, VaultCore has no reason to exist — everything else is negotiable.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current MVP (v0.1) scope. See .planning/REQUIREMENTS.md for REQ-IDs. -->

- [ ] Vault open flow (native folder picker, recent list, welcome screen, auto-load last vault)
- [ ] Indexing progress UI streamed via Tauri events (start, rebuild, batch > 500)
- [ ] CodeMirror 6 editor with Markdown live-preview, multi-tab, split-view
- [ ] Auto-save every 2 seconds with on-disk hash verification
- [ ] Tantivy full-text search with AND/OR/NOT/phrases and snippets
- [ ] Fuzzy quick switcher (Cmd/Ctrl+P) over filenames
- [ ] Wiki-links `[[Note]]` / `[[Note|alias]]` with Obsidian-compatible 3-stage shortest-path resolution
- [ ] Backlinks panel and unresolved-link detection
- [ ] Link autocompletion when typing `[[`
- [ ] File browser (lazy-loaded tree, create/rename/delete→.trash/move, drag-and-drop)
- [ ] Rename-cascade: auto-update all wiki-links after user confirmation dialog
- [ ] Inline and YAML-frontmatter tags with tag sidebar
- [ ] File watcher with write-ignore-list and 200ms batching (notify + rayon)
- [ ] Three-way merge engine for external file changes (local wins on conflict)
- [ ] Differentiated toast notifications (errors, clean merge, conflict)
- [ ] Dark/light mode, configurable font and size
- [ ] Cross-platform builds: macOS (Intel + Apple Silicon), Windows 10/11, Linux (Ubuntu 22.04+, Fedora 38+)
- [ ] Performance budgets met on a 100k-note test vault (see Constraints)

### Out of Scope

<!-- Explicit boundaries. Reasoning preserved so they don't sneak back in. -->

- **Plugin system** — deferred to v0.2; MVP stabilizes the core first
- **Graph view** — deferred to v0.3; not load-bearing for core value
- **Cloud sync / first-party sync** — files stay local; sync via third parties (Syncthing, iCloud, etc.)
- **Mobile app** — architecture is prepared for it, but not an MVP deliverable
- **WYSIWYG editor** — Markdown-first with live-preview is the explicit choice
- **Attachments / image embeds** (`![[image.png]]`) — architecture prepares for it, shipped post-MVP
- **Command palette** — Quick Switcher covers the MVP use case
- **SQLite or any persistent DB as primary store** — files are the source of truth; indexes are rebuildable caches
- **Telemetry / analytics / network calls** — fully offline, no tracking
- **TOML frontmatter** — YAML only, for Obsidian compatibility
- **Manual save (Cmd+S) / dirty indicator** — auto-save every 2s handles it
- **Following symbolic links** — displayed in browser but not resolved (cycle complexity)
- **File size limit** — none; CodeMirror 6 handles large files natively
- **License file / license headers in MVP** — intentionally deferred

## Context

- **Reference competitor:** Obsidian. VaultCore aims to open existing Obsidian vaults directly (shortest-path `[[wiki-links]]`, YAML frontmatter, `.obsidian/` folder ignored).
- **Performance reality of Obsidian at scale (referenced in spec Section 7):** cold start 10–30+ s, full-text search 2–10 s, quick switcher 500 ms – 4 s, backlinks 100–500 ms, RAM 300–800 MB idle. These are the numbers VaultCore needs to beat by 10–100x.
- **Architecture philosophy:** Files as source of truth, indexes as rebuildable cache, file watcher with write-ignore-list to avoid self-triggering, central Tantivy update queue to serialize index writes, three-way merge for concurrent edits with local-wins as the safe fallback.
- **Spec document of record:** `VaultCore_MVP_Spezifikation_v3.md` in the project root. The decision log (Section 17) is authoritative — any new decision that contradicts it requires explicit discussion.

## Constraints

- **Tech stack**: Tauri 2 + Rust backend, TypeScript + CodeMirror 6 frontend, Tantivy for full-text search, `notify` for FS watching, Zustand for state, Tailwind for styling — locked by spec Section 2.
- **Performance (100k-note vault, ~500 words/file)**:
  - Cold start < 3 s, warm start < 5 s
  - Open note < 100 ms, keystroke latency < 16 ms (60 fps)
  - Full-text search < 50 ms, quick switcher < 10 ms
  - Backlinks < 20 ms, link autocomplete < 10 ms
  - Initial indexing < 60 s, incremental update < 5 ms
  - RAM idle < 100 MB, active < 250 MB
- **Platforms**: macOS (Intel + Apple Silicon), Windows 10/11, Linux (Ubuntu 22.04+, Fedora 38+). No other targets in MVP.
- **Security**: zero network calls, zero telemetry, files never leave disk. Non-negotiable.
- **Compatibility**: must open existing Obsidian vaults without corrupting them. Shortest-path link resolution is spec-prescribed (exact match in same folder → shortest relative path → alphabetical tiebreak).
- **Crash recovery**: ≤ 2 s of unsaved content loss is acceptable; no write-ahead log in MVP.

## Key Decisions

<!-- Decisions that constrain future work. Pulled from spec Section 17. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Editor: CodeMirror 6 | Battle-tested at millions of lines; Obsidian's choice | — Pending |
| State: Zustand | 1KB, fast, adequate for multi-tab/split state | — Pending |
| Metadata store: pure in-memory (no SQLite) | Simpler architecture; Rust parser fast enough to rebuild from disk on start | — Pending |
| Frontmatter: YAML only | Obsidian compatibility; TOML adds complexity with no benefit | — Pending |
| Auto-save: fixed 2 s, no manual save | Removes dirty-state UI and user ceremony | — Pending |
| Delete → `.trash/` in vault | No permanent deletion; user can recover | — Pending |
| External changes: three-way merge, local wins on conflict | Safe fallback; differentiated toast for clean merge vs conflict | — Pending |
| Conflict detection based on CM6 `docChanged`, not cursor | Placing a cursor ≠ editing; avoids false conflicts | — Pending |
| Write-ignore-list + 100 ms debounce | Prevent self-triggered watcher events (esp. macOS FSEvents double-firing) | — Pending |
| File-watcher batching: 200 ms debounce + rayon | Handles git-pull / syncthing bursts; progress UI ≥ 500 files | — Pending |
| Tantivy writes via central queue | Never two concurrent writes for the same file | — Pending |
| Wiki-link resolution: 3-stage (same folder → shortest path → alphabetical) | Obsidian-compatible, deterministic | — Pending |
| Tantivy index versioning via `index_version.json` | On schema-mismatch → automatic rebuild with progress UI | — Pending |
| Error UI: unified toast, no severity levels in MVP | Simpler UX; still differentiated for merge outcomes | — Pending |
| Non-UTF-8 files: display but don't open/index | Avoid editor corruption; toast on open attempt | — Pending |
| Symbolic links: display but don't resolve | Cycle detection complexity out of scope for MVP | — Pending |
| No attachments in MVP | Architecture prepared; feature post-MVP | — Pending |
| No command palette in MVP | Quick Switcher covers the use case | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-11 after initialization*
