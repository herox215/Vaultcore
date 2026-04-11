# Phase 1: Skeleton - Context

**Gathered:** 2026-04-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Tauri 2 + CodeMirror 6 scaffold that launches to a Welcome screen, opens a vault via native folder dialog, auto-loads the last vault on startup, renders a single `.md` file in CodeMirror 6 with Markdown live-preview (minimal), and auto-saves every 2 seconds. Toast surface is live and the `VaultError` enum is complete. This is the foundation every later phase builds on.

**In scope:** VAULT-01..06, IDX-02 (as a real file-walk façade, see D-18), EDIT-01, EDIT-02, EDIT-04, EDIT-09, UI-04, ERR-01.

**Explicitly NOT in scope:** file browser / sidebar tree (Phase 2), multi-tab / split-view (Phase 2), Tantivy full-text search (Phase 3), wiki-link parsing (Phase 4), tags / dark mode / remaining shortcuts (Phase 5), performance benchmarks (Phase 6).

</domain>

<decisions>
## Implementation Decisions

### Frontend framework & scaffold
- **D-01:** Svelte 5 (runes mode — `$state`, `$derived`, `$effect`) is the frontend framework. This is a deliberate choice over the spec's implied React (`.tsx` filenames in Section 10). Rationale: smaller runtime, compiled-away reactivity better matches the 100k-note perf target, native stores make Zustand redundant.
- **D-02:** Plain Svelte + Vite, **not** SvelteKit. A Tauri desktop webview has no server, no SSR, no URL routing — SvelteKit's router/adapter machinery is dead weight. Tabs/split-view/views are state-driven, not URL-driven.
- **D-03:** Scaffold via `pnpm create tauri-app@latest` using the `svelte-ts` template, then strip template demo code and replace with Section 10 layout (adapted to `.svelte` filenames — see D-05).
- **D-04:** Package manager is **pnpm**. Lockfile: `pnpm-lock.yaml`. Node engine: `>= 18`.
- **D-05:** Spec Section 10 filenames (`App.tsx`, `WelcomeScreen.tsx`, `CMEditor.tsx`, etc.) become `.svelte` files in practice. Same directory layout, different extensions. Downstream agents should NOT flag this as a deviation — it's a direct consequence of D-01.

### State management (SPEC DEVIATION)
- **D-06:** **Zustand is dropped.** State is managed via Svelte's native `writable` / `readable` / `derived` stores. This directly contradicts `PROJECT.md` Key Decisions and spec Section 17 Entscheidungslog, which both list Zustand as locked. Rationale: Svelte 5 ships stores natively; pulling Zustand on top would duplicate functionality and add a 1KB dep for no ergonomic win.
- **D-07:** **Action required outside this phase:** User must update `PROJECT.md` Key Decisions and `VaultCore_MVP_Spezifikation_v3.md` Section 2 + Section 17 to replace "State Management: Zustand" with "State Management: Svelte stores (native)". Until that happens, the spec's Entscheidungslog is no longer authoritative on this one row. CONTEXT.md is the current source of truth for this decision.
- **D-08:** Store files live where spec Section 10 prescribes (`src/store/vaultStore.ts`, `src/store/editorStore.ts`). Phase 1 only needs `vaultStore` (current vault path, recent list, vault status) and `editorStore` (active file path, editor content, last-save timestamp) — the other stores (`searchStore`, `uiStore`) land in their owning phases per D-14.

### TypeScript strictness
- **D-09:** `tsconfig.json` uses **maximally strict settings**: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. Greenfield project — no legacy debt, cheapest time to enforce, catches bugs before Phase 6 benchmark gate.

### Live-preview fidelity (Phase 1 takes the minimal slice)
- **D-10:** Phase 1 ships **minimal live-preview only**: `@codemirror/lang-markdown` with GFM enabled (tables, task lists, strikethrough parsing), plus a CM6 theme extension that renders H1/H2/H3 at larger sizes. Bold/italic/inline-code stay styled via the default markdown highlight style with markers visible. This satisfies EDIT-01 and EDIT-02 by a reasonable reading of "inline live-preview".
- **D-11:** **DEFERRED to a dedicated follow-up phase** (not Phase 1, not Phase 5 Polish): hide-markers-on-non-active-lines (Obsidian "Live Preview" mode). Real engineering — CM6 state field + range decorations + viewport change listener — and pushes Phase 1 latency risk up.
- **D-12:** **DEFERRED to Phase 5 or later:** full HyperMD-style atomic widgets (hide-on-blur at node granularity, styled heading underlines, custom bullet widgets, atomic inline-code backgrounds). Weeks of work. Will be its own planning exercise when it lands.
- **D-13:** CM6 extension stack for Phase 1: `@codemirror/lang-markdown` (with GFM), `basicSetup` (history, bracket matching, line numbers, active-line highlight), a custom keymap extension wiring `Cmd/Ctrl+B`, `+I`, `+K` to wrap the current selection with `**...**`, `*...*`, and `[text](url)` respectively (satisfies EDIT-04), and a lean Tailwind-compatible light theme — **Claude's discretion** on exact theme values, but the theme MUST be structured so Phase 5 UI-01 dark mode is a drop-in swap (Tailwind CSS variables, not hardcoded hex).

### Single-file open flow (no file browser yet)
- **D-14:** Phase 1 has no sidebar file tree (that lands in Phase 2 / FILE-01). After a vault is opened, the main area shows a **minimal flat recursive file list** of all `.md` files found by walking the vault (using `walkdir`). No nesting, no icons, no lazy-load, no sort controls — just relative paths, sorted alphabetically. Click a path → the editor replaces the list. This code is **thrown away in Phase 2** when the real sidebar tree lands.
- **D-15:** "Auto-load last vault on startup" (VAULT-03) opens the vault and returns the user to the flat file list from D-14. It does **not** auto-open the last-edited file. Rationale: VAULT-03 says "last opened vault is loaded" not "last edited file is reopened", and adding last-file persistence now would introduce a second persistence schema that conflicts with Phase 2's multi-tab state.
- **D-16:** EDIT-11 (`Cmd/Ctrl+N` for new note) is **NOT implemented in Phase 1**. It stays mapped to Phase 5 as per `REQUIREMENTS.md` traceability. Phase 1 only opens pre-existing files. If the user wants to edit in Phase 1, they create the file outside VaultCore (`touch foo.md`) and pick it through the file list.
- **D-17:** Non-UTF-8 file handling is **pulled forward from Phase 2**: the Tauri `read_file` command returns `VaultError::InvalidEncoding` for non-UTF-8 bytes, the frontend shows a toast, and the file is not loaded into the editor. This costs ~10 lines and prevents auto-save from ever corrupting a binary/latin1 file the user accidentally picked. Wires `ERR-01` through a real error path on day 1.

### Module scaffold depth (lean)
- **D-18:** Scaffold **only the folders Phase 1 uses**. Do not create empty shell folders for deferred modules. Specifically:
  - **Frontend:** `src/components/Welcome/`, `src/components/Editor/`, `src/components/Toast/`, `src/components/Progress/`, `src/store/` (vaultStore + editorStore only), `src/ipc/commands.ts`, `src/styles/tailwind.css`.
  - **Backend:** `src-tauri/src/main.rs`, `src-tauri/src/error.rs` (full `VaultError` enum per spec Section 5, including `InvalidEncoding`), `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/vault.rs` (`open_vault`, `get_recent_vaults`, `get_vault_stats`), `src-tauri/src/commands/files.rs` (`read_file`, `write_file` only — no create/delete/rename yet).
  - **NOT scaffolded:** `src-tauri/src/indexer/`, `src-tauri/src/merge/`, `src-tauri/src/models/`, `src-tauri/src/commands/{search,links,tags}.rs`, `src/components/{Sidebar,Tabs,QuickSwitcher,Dialogs}/`, `src/store/{searchStore,uiStore}.ts`. These land with their owning phases.
- **D-19:** `Cargo.toml` Phase 1 dependency set is **only what's actually used**: `tauri` (v2), `serde`, `serde_json`, `thiserror`, `sha2` (for EDIT-10's hash-verify precondition wiring, even though EDIT-10 is Phase 5 — needed to establish the hash-write pattern), `walkdir` (for IDX-02 façade + flat file list), `tokio` (async runtime), `log`, `env_logger`. **NOT added in Phase 1:** `tantivy`, `notify`, `pulldown-cmark`, `regex`, `rayon`, `fuzzy-matcher`, `similar`, `chrono`. Phases 2–5 add their own deps when needed.
- **D-20:** Tauri v2 plugins added in Phase 1: **only** `@tauri-apps/plugin-dialog` (native folder picker for VAULT-01) and `@tauri-apps/plugin-fs` (file read/write + recent-vaults JSON persistence). No `plugin-os`, no `plugin-window-state` — added when their phase needs them.

### IDX-02 (progress UI) façade strategy
- **D-21:** IDX-02 is implemented in Phase 1 as a **real file walk emitting real Tauri progress events**, not a hardcoded animation. After vault open, the Rust backend runs a `walkdir` iterator over `.md` files and emits a `vault://index_progress` Tauri event with `{ current, total, current_file }` at a throttled cadence (e.g., every N files or every M milliseconds — Claude's discretion on cadence tuning). No Tantivy, no parsing, no hashing in Phase 1. Phase 3 replaces the walk body with the real indexer while keeping the same event channel — zero throwaway frontend code.
- **D-22:** The `total` count shown in the progress bar is determined by a first-pass walk to count files before the second pass emits progress (acceptable in Phase 1 where we're not indexing anything heavy; Phase 3 will make this decision again under real performance pressure).

### Recent vaults persistence
- **D-23:** Recent vaults stored as a single JSON file in the Tauri app-data directory (path resolved via `@tauri-apps/api/path` `appDataDir()`). Exact filename: `recent-vaults.json`. Schema: `{ "vaults": [{ "path": "/abs/path", "last_opened": "ISO-8601" }] }`. Cap the list at **10 entries**, evict oldest when full. Survives as-is into later phases (Phase 5 can extend it with more settings, or a separate `settings.json` file — Claude's discretion).

### Claude's Discretion
The following are explicitly left for Claude to decide during planning and execution, because they're low-risk and/or aesthetic:

- **Welcome screen visual layout** — centered card vs. full-bleed hero, exact copy, recent-list item format (path only, truncated middle, with or without last-opened timestamp), empty-state hint when no recent vaults exist.
- **Light theme exact values** — CM6 theme colors, Tailwind config palette (must use CSS variables so Phase 5 dark mode is a swap, not a rewrite).
- **Progress UI cadence** — how often to emit `index_progress` events (every N files, every M ms, or both), exact progress bar visual.
- **Test stack** — Vitest for Svelte component tests (Welcome screen, Toast, Editor wrapper), `cargo test` for Rust unit tests (`VaultError` variants, recent-vaults JSON round-trip, walkdir counter). No integration tests in Phase 1 — those land with Phase 6.
- **Lint/format tooling** — `eslint` + `prettier` (via `eslint-plugin-svelte` or `prettier-plugin-svelte`) for TypeScript/Svelte, `rustfmt` + `clippy` for Rust. Git hook: not required in Phase 1.
- **CI setup** — **not** in Phase 1 scope. REL-01..04 are mapped to Phase 6. Phase 1 produces a working local dev loop only.
- **Toast component visual** — uses the differentiated variants spec'd in UI-04 (error / clean-merge / conflict), but exact styling is Claude's call.
- **Tauri event naming conventions** — e.g., `vault://index_progress` vs. `vault:index_progress` vs. `index-progress`. Pick one convention and stay consistent.

### Folded Todos
None — no todos existed when this phase was scoped.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (authoritative)
- `VaultCore_MVP_Spezifikation_v3.md` §1 — Vision & Abgrenzung (what VaultCore is / is not in MVP)
- `VaultCore_MVP_Spezifikation_v3.md` §2 — Tech-Stack (**NOTE:** Zustand row is superseded by D-06 in this CONTEXT until the spec is updated)
- `VaultCore_MVP_Spezifikation_v3.md` §5 — Error Handling (full `VaultError` enum; Phase 1 implements all variants)
- `VaultCore_MVP_Spezifikation_v3.md` §6.1 — Vault öffnen (native dialog, recent list, Welcome screen, auto-load last vault)
- `VaultCore_MVP_Spezifikation_v3.md` §6.2 — Fortschrittsanzeige beim Start (IDX-02 behavior — D-21 explains the Phase 1 façade)
- `VaultCore_MVP_Spezifikation_v3.md` §6.3 — Markdown Editor (CM6 requirements; D-10..D-13 scope which parts land in Phase 1)
- `VaultCore_MVP_Spezifikation_v3.md` §6.4 — Auto-Save (fixed 2s, no manual save, no dirty indicator)
- `VaultCore_MVP_Spezifikation_v3.md` §9 — Tauri IPC Kommandos (Phase 1 implements `open_vault`, `get_recent_vaults`, `get_vault_stats`, `read_file`, `write_file` only)
- `VaultCore_MVP_Spezifikation_v3.md` §10 — Frontend-Struktur (**NOTE:** `.tsx` filenames become `.svelte` per D-05)
- `VaultCore_MVP_Spezifikation_v3.md` §11 — Rust Backend-Struktur (Phase 1 implements only the lean subset per D-18)
- `VaultCore_MVP_Spezifikation_v3.md` §12 — Rust Crate-Abhängigkeiten (Phase 1 uses only the subset per D-19)
- `VaultCore_MVP_Spezifikation_v3.md` §13 — Tastenkürzel (Phase 1 implements only `Cmd/Ctrl+B`, `+I`, `+K`)
- `VaultCore_MVP_Spezifikation_v3.md` §14 — Nicht-funktionale Anforderungen (security: zero network, zero telemetry — non-negotiable even in Phase 1)
- `VaultCore_MVP_Spezifikation_v3.md` §15 M1 — Skeleton milestone acceptance criteria
- `VaultCore_MVP_Spezifikation_v3.md` §17 — Entscheidungslog (**NOTE:** Zustand row is superseded by D-06)

### Planning artifacts
- `.planning/PROJECT.md` — Core value, constraints, Key Decisions table (**NOTE:** Zustand row superseded by D-06)
- `.planning/REQUIREMENTS.md` — `VAULT-01..06`, `IDX-02`, `EDIT-01`, `EDIT-02`, `EDIT-04`, `EDIT-09`, `UI-04`, `ERR-01` (and FILE-09 pulled forward per D-17)
- `.planning/ROADMAP.md` §Phase 1 — Skeleton goal, dependencies, success criteria

### External docs (for downstream agents to consult)
- Tauri v2 docs — https://v2.tauri.app/ (project setup, commands, events, plugin-dialog, plugin-fs)
- Svelte 5 runes — https://svelte.dev/docs/svelte/what-are-runes
- CodeMirror 6 — https://codemirror.net/docs/ (lang-markdown, basicSetup, EditorView, keymap)
- Tailwind CSS v3/v4 — https://tailwindcss.com/docs (dark mode via CSS variables, see D-13)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
None — this is a literal greenfield project. The repo contains only `CLAUDE.md`, `VaultCore_MVP_Spezifikation_v3.md`, and `.planning/`. No `package.json`, no `Cargo.toml`, no `src/`, no `src-tauri/`. Phase 1 creates all of them.

### Established Patterns
None yet. Phase 1 establishes:
- Tauri command error convention (return `Result<T, VaultError>`, `VaultError` implements `serde::Serialize` for frontend consumption)
- Tauri event channel naming (Claude's discretion per D-21, but pick and stick)
- Svelte store shape (reactive writable with a typed interface module)
- IPC wrapper pattern (`src/ipc/commands.ts` wraps every Tauri `invoke` call, typed)
- Toast variant discriminator (error / clean-merge / conflict per UI-04)
- Component file naming (`PascalCase.svelte`, matches Section 10's `.tsx` casing)

### Integration Points
Phase 1 creates every integration point for later phases:
- **Phase 2 hooks into:** `vaultStore` (for file tree state), `editorStore` (for multi-tab state), `src/components/Editor/` (for split-view), `src-tauri/src/commands/files.rs` (for create/delete/rename/move).
- **Phase 3 hooks into:** the `vault://index_progress` event channel (replaces the D-21 façade with real Tantivy indexing), `src-tauri/src/commands/vault.rs` (extends `open_vault` to kick off real indexing).
- **Phase 4 hooks into:** `src/components/Editor/` (for wiki-link CM6 plugin), `editorStore` (for resolved/unresolved link state).
- **Phase 5 hooks into:** the Tailwind CSS variable theme (for dark mode swap), `src/ipc/commands.ts` (adds settings commands), the Toast component (which it can extend).

</code_context>

<specifics>
## Specific Ideas

- "Feel like a real app from day 1" — IDX-02 façade with real file-walk progress events (D-21) over a hardcoded animation. The progress bar is the first visible sign that VaultCore is "doing backend work", and making it real on day 1 means Phase 3 doesn't have to rebuild the frontend-side plumbing.
- "Don't lie in the demo" — the flat file list (D-14) is ugly but honest about Phase 1's scope, rather than faking a sidebar tree.
- The `Welcome` → `VaultView` transition should feel instant when the vault is already in the recent list (auto-load path). If it's a first-time vault pick that triggers the D-21 walk, the user should see the progress UI immediately, not a blank screen.
- Svelte + CM6: CM6 is framework-agnostic and mounts into a plain DOM element. The Svelte wrapper component (`CMEditor.svelte`) should create the `EditorView` inside a `bind:this` DOM ref in `onMount`, and destroy it in `onDestroy`. Svelte 5 runes don't change this pattern.

</specifics>

<deferred>
## Deferred Ideas

- **Live-preview Option 2** (hide markers on non-active lines — Obsidian "Live Preview" mode) — dedicated follow-up phase after Phase 1. Real CM6 engineering. Scope is well understood enough that it could be a standalone "Phase 1.5" or land at the start of Phase 5.
- **Live-preview Option 3** (full HyperMD-style atomic widgets, full Obsidian parity) — Phase 5 Polish or a dedicated follow-on. Weeks of work, highest latency risk.
- **Last-edited file persistence per vault** — Phase 2, when multi-tab state needs persistence anyway. Keeps Phase 1's persistence schema single-file.
- **`Cmd/Ctrl+N` new file (EDIT-11)** — Phase 5 as per existing traceability. Phase 1 explicitly doesn't ship it.
- **Dark mode / runtime theme toggle (UI-01)** — Phase 5. Phase 1's Tailwind theme must use CSS variables so the Phase 5 swap is clean.
- **Window state persistence** (window size / position / fullscreen across restarts) — Phase 5 or Phase 6, via `plugin-window-state`. Not worth adding a plugin for in Phase 1.
- **Vitest + `cargo test` CI integration** — Phase 6 (REL-02). Phase 1 produces working local tests; CI wiring lands with the release gate.
- **License file / LICENSE header** — explicitly deferred per PROJECT.md Out of Scope and spec Section 17.

### Reviewed Todos (not folded)
None — no todos existed.

</deferred>

---

*Phase: 01-skeleton*
*Context gathered: 2026-04-11*
