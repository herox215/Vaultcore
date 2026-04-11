# Phase 1: Skeleton - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-11
**Phase:** 01-skeleton
**Areas discussed:** Frontend framework, Live-preview fidelity, Single-file open flow, Scaffold depth

---

## Frontend framework

### Q1: Which frontend framework?

| Option | Description | Selected |
|--------|-------------|----------|
| React (Recommended) | Spec's .tsx filenames imply it. Largest ecosystem, mature CM6 bindings. | |
| Solid | .tsx compatible. Fine-grained reactivity better for 100k-note app. Smaller Tauri ecosystem. | |
| Svelte | Smallest runtime, compiled away. Requires .tsx → .svelte renames. Built-in stores conflict with Zustand decision. | ✓ |
| Vanilla TS | Leanest, max control, but much more boilerplate. | |

**User's choice:** Svelte
**Notes:** User deviated from the recommended option knowingly, triggering the Zustand conflict surfacing in the next round of questions.

### Q2: Scaffold approach?

| Option | Description | Selected |
|--------|-------------|----------|
| create-tauri-app template (Recommended) | pnpm create tauri-app@latest with svelte-ts template. Working Vite + Svelte + Tauri v2 skeleton in one command. | ✓ |
| Hand-roll from scratch | Empty src-tauri + src, wire tauri.conf.json + Vite + tsconfig by hand. | |

**User's choice:** create-tauri-app template

### Q3: Package manager?

| Option | Description | Selected |
|--------|-------------|----------|
| pnpm (Recommended) | Fast, disk-efficient, Tauri docs use it prominently. | ✓ |
| npm | Default and most universal. Slower, bigger node_modules. | |
| bun | Fastest installs but young, some Tauri v2 edge cases. | |

**User's choice:** pnpm

### Q4: TypeScript strictness?

| Option | Description | Selected |
|--------|-------------|----------|
| Strict everything (Recommended) | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes. | ✓ |
| Strict default | strict: true only. Template default. | |
| Gradual | Strict off initially. | |

**User's choice:** Strict everything

### Q5: State management (spec conflict)

| Option | Description | Selected |
|--------|-------------|----------|
| Svelte stores (Recommended) | Drop Zustand, use Svelte's native writable/readable/derived. Logged as explicit spec deviation. | ✓ |
| Zustand via vanilla API | Honors spec literally but adds redundant 1KB dep. | |
| Both (Svelte stores + Zustand) | Two mental models, not recommended. | |

**User's choice:** Svelte stores (Recommended)
**Notes:** Spec deviation. CONTEXT.md D-07 flags that PROJECT.md Key Decisions and spec Section 17 Entscheidungslog must be updated to drop Zustand so the authoritative decision log stays in sync.

### Q6: Svelte version?

| Option | Description | Selected |
|--------|-------------|----------|
| Svelte 5 (runes) (Recommended) | $state / $derived / $effect. Clearer reactivity model. | ✓ |
| Svelte 4 | More mature ecosystem, compiled-magic reactivity. | |

**User's choice:** Svelte 5 (runes)

### Q7: SvelteKit or plain Svelte + Vite?

| Option | Description | Selected |
|--------|-------------|----------|
| Plain Svelte + Vite (Recommended) | SvelteKit's routing/SSR is dead weight in a Tauri webview. | ✓ |
| SvelteKit (SPA mode) | File-based routing in SPA mode. Adds unused infra. | |

**User's choice:** Plain Svelte + Vite

---

## Live-preview fidelity

### Q1: Which live-preview fidelity level for Phase 1?

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal: lang-markdown + heading sizes (Recommended) | @codemirror/lang-markdown + theme rendering headings at larger sizes. Markers visible. | ✓ (Phase 1) |
| Intermediate: hide markers on non-active lines | Minimal + CM6 decoration hiding markers on non-cursor lines. | (deferred) |
| Full: HyperMD-style hide-on-blur with atomic widgets | Full Obsidian parity. Weeks of work, highest latency risk. | (deferred) |

**User's choice:** "First 2, then 3" (free text)
**Notes:** Claude interpreted as "Reading A": Phase 1 ships Minimal only; Option 2 deferred to a dedicated follow-up phase after Phase 1; Option 3 deferred to Phase 5 or later. User confirmed "yes and yes" to Claude's follow-up questions which resolved the boundary.

### Q2: Which CM6 extensions ship in Phase 1? (multiSelect)

| Option | Description | Selected |
|--------|-------------|----------|
| lang-markdown + GFM (Recommended) | Tables, task lists, strikethrough via @codemirror/lang-markdown. | ✓ |
| basicSetup (Recommended) | history, bracketMatching, lineNumbers, highlightActiveLine. | ✓ |
| Custom keymap for EDIT-04 | Cmd/Ctrl+B/I/K wrapping selection. | ✓ (implied, confirmed by user follow-up "yes and yes") |
| Theme: neutral light Tailwind palette | CM6 theme using Tailwind CSS variables, structured for Phase 5 dark swap. | ✓ (Claude's discretion, confirmed by user follow-up) |

**User's choice:** All four, the latter two confirmed as implied and Claude's discretion respectively.

### Q3: Non-UTF-8 file handling in Phase 1?

| Option | Description | Selected |
|--------|-------------|----------|
| Backend rejects + toast (Recommended) | read_file returns VaultError::InvalidEncoding, frontend shows toast, no editor load. Pulls FILE-09 forward. | ✓ |
| Defer entirely to Phase 2 | from_utf8_lossy and let user see replacement characters. | |

**User's choice:** Backend rejects + toast

---

## Single-file open flow

### Q1: How does user pick a .md file in Phase 1?

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal flat file list (Recommended) | After vault pick, main area shows scrollable list of .md files. Click → editor. Thrown away in Phase 2. | ✓ |
| Native open-file dialog | Button triggers Tauri native file dialog with .md filter. | |
| Auto-open first .md | Walk vault, open first .md alphabetically. Zero-click. | |
| Drag-drop | User drags .md onto window. | |

**User's choice:** Minimal flat file list
**Notes:** Claude interpreted "flat list" as recursive (walkdir) rather than root-only, since root-only would be useless on real Obsidian vaults with nested folders. Interpretation was called out in the summary; user did not push back.

### Q2: What does auto-load-last-vault load on startup?

| Option | Description | Selected |
|--------|-------------|----------|
| Vault only (Recommended) | Open vault, return to file picker flow. Matches VAULT-03 literally. | ✓ |
| Vault + last-edited file path | Persist per-vault last file, auto-open. | (deferred to Phase 2) |

**User's choice:** Vault only

### Q3: Ship EDIT-11 (Cmd/Ctrl+N new file) in Phase 1?

| Option | Description | Selected |
|--------|-------------|----------|
| No — defer to Phase 5 (Recommended) | EDIT-11 stays mapped to Phase 5 per REQUIREMENTS.md. | ✓ |
| Yes — pull forward | Ship Cmd/Ctrl+N in Phase 1. | |

**User's choice:** No — defer to Phase 5

---

## Scaffold depth

### Q1: How much of Section 10/11 module tree do we scaffold?

| Option | Description | Selected |
|--------|-------------|----------|
| Lean — only Phase 1 folders (Recommended) | Create only Welcome, Editor, Toast, Progress frontend folders; vault/files backend commands only. | ✓ |
| Full spec tree as empty shells | All Section 10/11 folders as empty placeholders. | |
| Hybrid — lean folders, full Cargo.toml deps | Lean folders but all Section 12 deps up front. | |

**User's choice:** Lean

### Q2: How do we stub IDX-02 progress UI in Phase 1?

| Option | Description | Selected |
|--------|-------------|----------|
| Real file walk + real progress events (Recommended) | walkdir over vault, emit Tauri progress events. Phase 3 replaces walk body with real indexer. Zero throwaway frontend code. | ✓ |
| Hardcoded animation | Fake 0-100% over fixed duration. | |
| Skip IDX-02 in Phase 1 | Defer to Phase 3, update REQUIREMENTS.md traceability. | |

**User's choice:** Real file walk + real progress events

### Q3: Which Tauri v2 plugins in Phase 1?

| Option | Description | Selected |
|--------|-------------|----------|
| Only what Phase 1 needs (Recommended) | plugin-dialog + plugin-fs only. | ✓ |
| Pre-register everything | Add plugin-os, plugin-window-state up front too. | |

**User's choice:** Only what Phase 1 needs

### Q4: Anything else to discuss before writing CONTEXT.md?

| Option | Description | Selected |
|--------|-------------|----------|
| No, Claude's discretion on the rest (Recommended) | Welcome layout, theme values, test stack, lint/format, CI all Claude's call. | ✓ |
| Yes, more questions | | |

**User's choice:** No, Claude's discretion on the rest

---

*Discussion log for phase 01-skeleton*
*Date: 2026-04-11*
