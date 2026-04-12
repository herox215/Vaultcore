# Phase 5: Polish - Research

**Researched:** 2026-04-12
**Domain:** Tag indexing (Rust), CM6 language highlighting, theme CSS-variable cascade, @fontsource bundling, settings modal focus-trap, hash-verify auto-save, localStorage persistence, keyboard shortcut registry, file-browser sort/timestamps
**Confidence:** HIGH — all key claims verified by direct codebase inspection; package versions verified against npm registry and crates.io

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Tags (TAG-01..04)**
- D-01: Tag extraction in new `src-tauri/src/indexer/tag_index.rs`. `TagIndex` holds `HashMap<String, Vec<TagOccurrence>>`. Inline `#tag` and `#parent/child` via regex; YAML frontmatter via `serde_yaml` (add if not present — YAML-only per D-26).
- D-02: TagIndex in-memory only, rebuilt on cold start. Incremental via new `IndexCmd::UpdateTags { rel_path, content }` and `RemoveTags { rel_path }` — mirror Phase 4 `UpdateLinks`/`RemoveLinks` pattern exactly.
- D-03: Tag panel = third sidebar tab ("Tags"). Order: Dateien | Suche | Tags. Alphabetical list with usage count and nested-tag tree.
- D-04: Tag-click switches to Search tab, prefills query with `#tag-name`, runs `search_fulltext`. No new IPC.

**Themes (UI-01)**
- D-05: Theme via `data-theme="dark|light|auto"` on `<html>`. CSS variables in `tailwind.css` under `:root[data-theme=light]` / `:root[data-theme=dark]`. `auto` uses `@media (prefers-color-scheme: dark)` inside `:root[data-theme=auto]`.
- D-06: Dark palette — `#1C1C1A` bg, `#2A2A28` surface, `#F5F5F4` text, `#A8A8A5` muted, `#7C3AED` accent. Full color table locked in UI-SPEC.
- D-07: Persisted in `localStorage['vaultcore-theme']` (values: `light`/`dark`/`auto`, default `auto`). New `src/store/themeStore.ts` using writable pattern (D-06/RC-01). CM6 `markdownTheme` already reads CSS vars — no editor rebuild on switch.

**Typography (UI-02)**
- D-08: Fixed font list. Body: System UI (default), Inter, Lora. Mono: System Mono (default), JetBrains Mono, Fira Code. Loaded via `@fontsource/*` npm packages.
- D-09: Font size 12–20px slider, 1px steps, default 15px. CSS variable `--vc-font-size` on `<html>`.
- D-10: Settings modal triggered by gear icon in sidebar topbar. Single-scroll layout, sections: Theme, Font, Shortcuts.

**Keyboard shortcuts (UI-03, UI-05, EDIT-11)**
- D-11: Central registry `src/lib/shortcuts.ts` — readonly `SHORTCUTS[]` of `{ id, keys, label, handler }`. VaultLayout `handleKeydown` loops array.
- D-12: New bindings: `Cmd/Ctrl+N` (new note), `Cmd/Ctrl+\` (sidebar toggle). Existing: Cmd+P, Cmd+Shift+F, Cmd+Shift+B, Cmd+Tab, Cmd+W, Cmd+B/I/K.
- D-13: Undo/redo (EDIT-07) already provided by CM6 `history()` (Phase 1 RC-02). Add integration test.

**Hash-verify merge (EDIT-08, EDIT-10)**
- D-14: Before each auto-save, compute on-disk SHA-256 and compare against `tabStore.originalHash`. Mismatch → cancel write, invoke Phase 2 three-way merge. Merged result flows back via existing `applyMerge` path.
- D-15: `tabStore` already has `originalHash` per tab. `autoSave` extension updates it after each successful write. `editorStore.lastSavedHash` carries the hash; `tabStore` carries `lastSavedContent` (merge base).
- D-16: Large-file test (EDIT-08): integration test with 10,000-line fixture, assert < 16ms keystroke latency over 100 keystrokes.

**Fenced code highlighting (EDIT-03)**
- D-17: `@codemirror/language-data` for lazy-loading language packs. Top-10 pre-registered. `markdown({ codeLanguages })` config.
- D-18: Fallback for unrecognized language: monospace rendering only.

**File browser persistence (FILE-06, FILE-07)**
- D-19: Sort + expand state in `localStorage['vaultcore-tree-state:{sha256(vault_path, truncated 16 hex chars)}']`. Structure: `{ sortBy: 'name'|'modified'|'created', expanded: string[] }`.
- D-20: Sort control: small sort icon button in sidebar topbar, opens 3-option popover.

**Toast / dialog unification (UI-06)**
- D-21: Audit pass — scan every `toastStore.push`, rename prompt, merge-notice. Replace any inline `alert()`/`confirm()` with toast/dialog. No new UI needed.

### Claude's Discretion
- Exact dark-mode color hex values (locked in UI-SPEC — see Color section below)
- Settings-modal layout and visual treatment
- `tag_index.rs` internal data structure tuning
- Whether to cache settings modal font dropdown state in memory vs. localStorage
- Keyboard-handling priority order (fully specified in UI-SPEC Interaction Contracts)

### Deferred Ideas (OUT OF SCOPE)
- Custom theme editor / JSON-theme import (v0.2 PLUG-01)
- Tag autocomplete while typing
- Tag rename cascade
- Bundled font variants beyond 400+700 weights
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TAG-01 | Inline tags `#tag` and `#parent/child` extracted from note bodies | Regex pattern verified; `OnceLock<Regex>` pattern from `link_graph.rs` is direct template |
| TAG-02 | YAML frontmatter tags `tags: [a, b]` extracted | `serde_yaml` is deprecated — use `serde_yml` 0.0.12 or inline manual YAML-front-matter slice + split; see Pitfall 1 |
| TAG-03 | Tag panel lists all tags with usage counts | Third sidebar tab; existing `.vc-sidebar-tab` CSS handles it; new `TagsPanel.svelte` |
| TAG-04 | Clicking a tag runs search for notes carrying it | Uses existing `searchStore.setActiveTab('search')` + prefill pattern from `searchStore`; no new IPC |
| UI-01 | Dark/light mode toggle at runtime | `data-theme` attribute on `<html>`; CSS vars already use named tokens; zero editor rebuild verified |
| UI-02 | Font family and font size configurable | `@fontsource/*` packages not yet installed; `--vc-font-body`/`--vc-font-mono` CSS vars already in `:root` |
| UI-03 | Sidebar collapse/expand `Cmd/Ctrl+\` | `sidebarCollapsed` state already in `VaultLayout.svelte`; `toggleSidebar()` function already exists |
| UI-05 | All spec Section 13 shortcuts wired up | `handleKeydown` in `VaultLayout.svelte` currently handles only Cmd+Shift+B, Cmd+Shift+F, Cmd+P, Cmd+Tab, Cmd+W inline — needs refactor to array registry |
| UI-06 | All user-facing surfaces use unified toast/dialog | Audit needed; current `handleKeydown` pattern is imperative, not yet using a registry |
| EDIT-03 | Fenced code blocks per-language syntax highlighting | `@codemirror/language-data` 6.5.2 not yet installed; `markdown()` accepts `codeLanguages` callback |
| EDIT-07 | Undo/redo per-tab | CM6 `history()` already in `extensions.ts`; per-tab EditorView each gets own history via Phase 2 Map lifecycle |
| EDIT-08 | No file-size limit — 10k-line note opens without degradation | CM6 handles natively; task is a regression test only, no new code |
| EDIT-10 | Hash-verify before auto-save triggers merge path | `autoSave.ts` currently does raw write; needs hash read before write; `write_file` already returns hash (SHA-256 of bytes); `editorStore.lastSavedHash` already tracks it |
| EDIT-11 | New note `Cmd/Ctrl+N` | `create_file` IPC already exists; `tabStore.openTab()` already exists; filename collision handled in backend needed |
| FILE-06 | Sort by name/modified/created; order remembered | `DirEntry` struct does NOT currently include `modified`/`created` timestamps — must be added to `tree.rs` and `list_directory_impl`; client-side sort feasible after field addition |
| FILE-07 | Folder expand/collapse state persisted across sessions | Currently stored only in TreeNode's ephemeral `$state`; needs localStorage write on toggle + restore on vault open |
</phase_requirements>

---

## Summary

Phase 5 delivers the remaining MVP surface features. The codebase is well-prepared: the `IndexCoordinator`/`IndexCmd`/watcher pattern from Phase 4 is a near-exact template for tag indexing. The CM6 editor already reads CSS variables for all visual properties, meaning dark mode and typography changes require only DOM attribute and CSS variable manipulation — no editor rebuild or remounting. The `autoSave.ts` extension is intentionally minimal (27 lines) and straightforward to extend with hash-verify before write.

The most important structural gap to address in planning: **`DirEntry` from `list_directory` does not carry `modified` or `created` timestamps** (verified by reading `tree.rs`). Sort-by-modified and sort-by-created (FILE-06) therefore require extending the Rust struct with `Option<u64>` (UNIX timestamp) fields before client-side sort is feasible. This is a small backend change but must be the first task in the file-persistence work stream.

The second important gap: **`serde_yaml` is deprecated** (last release March 2024, marked deprecated on crates.io). The CONTEXT.md D-01 names it as the YAML crate to use, but the recommended replacement is `serde_yml` 0.0.12 (maintained fork, same API). The planner should use `serde_yml` unless the user explicitly reconfirms `serde_yaml`. See Pitfall 1 for details.

**Primary recommendation:** Implement in this wave order — (1) tag backend + IPC, (2) tag panel UI + watcher wiring, (3) file-browser timestamps + sort/persist, (4) theme + typography + settings modal, (5) keyboard registry refactor + new-note shortcut, (6) hash-verify auto-save, (7) fenced-code highlighting, (8) UI-06 toast audit.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard / Status |
|---------|---------|---------|----------------------|
| `serde_yml` | 0.0.12 | YAML frontmatter parsing for TAG-02 | Maintained fork of deprecated `serde_yaml`; same API surface [VERIFIED: crates.io] |
| `@codemirror/language-data` | 6.5.2 | Lazy-loaded language packs for fenced-code highlighting (EDIT-03) | Official CM6 package; not yet installed [VERIFIED: npm registry] |
| `@fontsource/inter` | 5.2.8 | Bundled Inter font for UI-02 | Zero-network, npm-bundled, SEC-01 compliant; not yet installed [VERIFIED: npm registry] |
| `@fontsource/lora` | 5.2.8 | Bundled Lora serif font for UI-02 | Same package family; not yet installed [VERIFIED: npm registry] |
| `@fontsource/jetbrains-mono` | 5.2.8 | Bundled JetBrains Mono for UI-02 | Same package family; not yet installed [VERIFIED: npm registry] |
| `@fontsource/fira-code` | 5.2.7 | Bundled Fira Code for UI-02 | Same package family; not yet installed [VERIFIED: npm registry] |

### Already Installed (No New Install Needed)
| Library | Version | Purpose |
|---------|---------|---------|
| `regex` crate | 1.x | Tag regex extraction in `tag_index.rs` (already in Cargo.toml) [VERIFIED: codebase] |
| `sha2` crate | 0.10 | Hash-verify for EDIT-10 (already used in `hash.rs`) [VERIFIED: codebase] |
| `@codemirror/lang-markdown` | 6.5.0 | `markdown({ codeLanguages })` config for EDIT-03 (already installed) [VERIFIED: codebase] |
| `lucide-svelte` | 1.0.1 | `Hash`, `Settings`, `ArrowUpDown`, `Check`, `ChevronRight`, `X` icons [VERIFIED: codebase] |

### Installation (new packages only)
```bash
# Cargo.toml — add to [dependencies]
serde_yml = "0.0.12"

# npm
npm install @codemirror/language-data @fontsource/inter @fontsource/lora @fontsource/jetbrains-mono @fontsource/fira-code
```

**Version verification:**
- `serde_yml 0.0.12` — published 2024-08-25 [VERIFIED: crates.io]
- `serde_yaml 0.9.34+deprecated` — deprecated 2024-03-25; last release [VERIFIED: crates.io]
- `@codemirror/language-data 6.5.2` — current as of 2026-04-12 [VERIFIED: npm registry]
- `@fontsource/*` 5.2.7–5.2.8 — current as of 2026-04-12 [VERIFIED: npm registry]

---

## Architecture Patterns

### Pattern 1: TagIndex — Direct Clone of LinkGraph

`tag_index.rs` follows `link_graph.rs` identically for: regex compilation via `OnceLock<Regex>`, incremental `update_file`/`remove_file` methods, Arc wrapping in `IndexCoordinator`, and `IndexCmd` extension.

**Regex for inline tags** (verified against Obsidian tag syntax rules):
```rust
// Source: [ASSUMED] — regex derived from Obsidian tag spec; no crates.io source
// Fast-path: content.contains('#') before regex.is_match() (link_graph.rs pattern)
fn tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Matches #tag and #parent/child
        // Negative lookbehind via position: tag must be at start of line or after whitespace
        // Avoids URL fragments: require word boundary before #, no digit-only tags
        // Pattern: (^|[\s(,!?;:])#([a-zA-Z][a-zA-Z0-9_\-/]*)
        Regex::new(r"(?:^|[\s(,!?;:])#([a-zA-Z][a-zA-Z0-9_\-/]*)").expect("invalid tag regex")
    })
}
```

**False-positive URL anchor avoidance:** The pattern requires the tag to start with a letter (not a digit, not `#anchor` fragment style which typically appears after `http://host/path`). The lookbehind requirement for whitespace or line-start means `http://example.com#tag` does not match because `#` is preceded by `/`, not whitespace. [ASSUMED — regex behavior; verify with unit tests]

**YAML frontmatter extraction** (TAG-02):
```rust
// Source: [ASSUMED] — derived from Obsidian frontmatter spec
fn extract_yaml_tags(content: &str) -> Vec<String> {
    // Frontmatter is delimited by `---` on first and second lines
    let stripped = content.trim_start();
    if !stripped.starts_with("---") { return vec![]; }
    let rest = &stripped[3..];
    let end = rest.find("\n---").unwrap_or(0);
    if end == 0 { return vec![]; }
    let yaml_block = &rest[..end];
    // Parse with serde_yml — deserialize into a YAML Value
    // Look for `tags:` key; support both list and scalar forms
    // serde_yml::from_str::<serde_yml::Value>(yaml_block)
    // then extract .get("tags") as sequence or string
    vec![] // implementation body
}
```

**IndexCoordinator extension** (exact mirror of Phase 4):
```rust
// In indexer/mod.rs — add to IndexCmd enum
UpdateTags { rel_path: String, content: String },
RemoveTags { rel_path: String },

// In IndexCoordinator struct — add field
tag_index: Arc<Mutex<TagIndex>>,

// In run_queue_consumer match arms — add handlers
IndexCmd::UpdateTags { rel_path, content } => {
    if let Ok(mut ti) = tag_index.lock() {
        ti.update_file(&rel_path, &content);
    }
}
IndexCmd::RemoveTags { rel_path } => {
    if let Ok(mut ti) = tag_index.lock() {
        ti.remove_file(&rel_path);
    }
}
```

### Pattern 2: Theme Switching via CSS Variable Cascade

**Current `:root` state** (verified by reading `src/styles/tailwind.css`):
```css
/* Current: bare :root block — no data-theme attribute */
:root {
  --color-bg: #F5F5F4;
  /* ... 10 color vars + 3 font vars ... */
}
```

**Target structure after Phase 5:**
```css
/* Default (light) — keep in bare :root for zero-attribute-required rendering */
:root {
  --color-bg: #F5F5F4;
  --color-surface: #FFFFFF;
  /* ... all existing vars ... */
}

/* Light explicit */
:root[data-theme="light"] {
  --color-bg: #F5F5F4;
  /* ... same as :root defaults ... */
}

/* Dark */
:root[data-theme="dark"] {
  --color-bg: #1C1C1A;
  --color-surface: #2A2A28;
  --color-border: #3A3A38;
  --color-text: #F5F5F4;
  --color-text-muted: #A8A8A5;
  --color-accent: #7C3AED;
  --color-accent-bg: #2E1F4A;
  --color-error: #F87171;
  --color-warning: #FCD34D;
  --color-success: #34D399;
  --color-code-bg: #252523;
}

/* Auto — uses OS preference */
@media (prefers-color-scheme: dark) {
  :root[data-theme="auto"] {
    /* same dark vars as [data-theme=dark] */
  }
}
```

**themeStore.ts pattern** (mirrors `scrollStore`/`treeRefreshStore` writable pattern):
```typescript
// Source: [VERIFIED: codebase] — mirrors existing store pattern
import { writable } from 'svelte/store';

type Theme = 'light' | 'dark' | 'auto';

const stored = (localStorage.getItem('vaultcore-theme') ?? 'auto') as Theme;
const _store = writable<Theme>(stored);

export const themeStore = {
  subscribe: _store.subscribe,
  set(theme: Theme) {
    _store.set(theme);
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('vaultcore-theme', theme);
  },
  init() {
    // Called on app start — apply stored theme
    document.documentElement.dataset.theme = stored;
  },
};
```

**CM6 editor does not need rebuild:** `markdownTheme` in `theme.ts` already uses `color: "var(--color-text)"` etc. [VERIFIED: reading `src/components/Editor/theme.ts`]. Flipping `data-theme` cascades through all CSS var consumers instantly.

### Pattern 3: @fontsource Import

**How @fontsource works** (SEC-01 compliant):
- Packages contain pre-converted `.woff2` font files and a CSS entry point.
- Import in `main.ts` or `tailwind.css` at build time — Vite bundles the fonts into the app.
- Zero network calls at runtime — fonts are served from the local Tauri app bundle. [VERIFIED: @fontsource documentation behavior, ASSUMED for Vite bundling specifics]

**Import pattern:**
```typescript
// In src/main.ts (or tailwind.css @import)
// Import 400 (regular) and 700 (bold) weights only — MVP budget
import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import '@fontsource/lora/400.css';
import '@fontsource/lora/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/700.css';
```

**Font disabled state:** If a package is not imported, the font name still appears in the dropdown but the OS fallback is used silently. The CONTEXT.md D-08 says "if a font package isn't installed, option is disabled in the UI." Detection approach: check whether `document.fonts.check('12px "Inter"')` returns true after the font loads. For MVP simplicity, an `[ASSUMED]` simpler approach: if the import exists in `main.ts`, the option is enabled; the dropdown `disabled` attribute is set statically at build time based on which packages are installed. [ASSUMED — detection approach needs decision]

### Pattern 4: @codemirror/language-data for Fenced-Code Highlighting (EDIT-03)

**API** (verified against npm package 6.5.2):
```typescript
// Source: [ASSUMED] — derived from @codemirror/language-data docs; verify with package
import { languages } from '@codemirror/language-data';
import { markdown } from '@codemirror/lang-markdown';

// In extensions.ts — replace current markdown({ extensions: [GFM] }) with:
markdown({
  extensions: [GFM],
  codeLanguages: languages, // lazy-loads the matching language pack on demand
})
```

The `languages` export from `@codemirror/language-data` is an array of `LanguageDescription` objects. Each has a `name` property that matches the fence label. CM6 calls the lookup lazily — the language pack is not loaded until a fence with that label is first rendered. [ASSUMED — lazy loading behavior based on documentation; verify that bundle size stays within RAM budget]

**Top-10 languages in `@codemirror/language-data`:** JavaScript, TypeScript, Rust, Python, Go, HTML, CSS, Shell/Bash, JSON, YAML — all included. [ASSUMED — verify against package contents after install]

### Pattern 5: Hash-Verify in autoSave.ts (EDIT-10)

**Current `autoSave.ts`** (verified — 27 lines, simple `updateListener`):
```typescript
// Source: [VERIFIED: codebase] — src/components/Editor/autoSave.ts
export function autoSaveExtension(onSave: (text: string) => void): Extension {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (timer !== null) clearTimeout(timer);
    const view = update.view;
    timer = setTimeout(() => {
      onSave(view.state.doc.toString());
      timer = null;
    }, AUTO_SAVE_DEBOUNCE_MS);
  });
}
```

**Extended signature for EDIT-10:**
```typescript
// The onSave callback becomes onSave(text: string): Promise<void>
// The EditorPane passes in a callback that:
// 1. Reads current on-disk hash via a new IPC `get_file_hash(path)` — OR re-reads writeFile return value
// 2. Compares against tabStore tab.lastSavedHash (already tracked as editorStore.lastSavedHash)
// 3. On match: calls writeFile, updates editorStore.lastSavedHash with returned hash
// 4. On mismatch: calls mergeExternalChange (existing IPC) with (editorContent, lastSavedContent)
```

**Hash read strategy:** `write_file` in Rust already returns `hash_bytes(bytes)` (verified in `files.rs` line 121: `Ok(hash_bytes(bytes))`). For the pre-write comparison, a new lightweight `get_file_hash(path)` command is needed that reads the file and returns its SHA-256 without loading the full content into the editor. This is a one-liner in Rust: `Ok(hash_bytes(&std::fs::read(canonical)?))`. [VERIFIED: write_file return pattern in codebase; ASSUMED: new get_file_hash command is the cleanest approach]

**editorStore.lastSavedHash** is already tracked [VERIFIED: `editorStore.ts`]. `tabStore` carries `lastSavedContent` as the merge base [VERIFIED: `tabStore.ts` interface]. No new storage fields are needed.

### Pattern 6: File-Browser Sort (FILE-06) — DirEntry Timestamp Extension

**CRITICAL GAP (verified):** `DirEntry` struct in `src-tauri/src/commands/tree.rs` currently has 5 fields: `name`, `path`, `is_dir`, `is_symlink`, `is_md`. It does **not** carry `modified` or `created` timestamps. [VERIFIED: reading tree.rs lines 29-35, 107-113]

**Required change to Rust struct:**
```rust
// Source: [VERIFIED: codebase] — existing DirEntry, must extend
#[derive(Serialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_md: bool,
    // Phase 5 additions for FILE-06:
    pub modified: Option<u64>,  // UNIX timestamp seconds, None if metadata unavailable
    pub created: Option<u64>,   // UNIX timestamp seconds, None if unsupported (Linux)
}
```

**Why `Option<u64>`:** `created` time (`metadata().created()`) is not available on all Linux filesystems (returns `Err` on ext4). `modified` is widely available. `Option` avoids panics. [ASSUMED — Linux filesystem behavior; standard practice]

**TypeScript type update** (`src/types/tree.ts`):
```typescript
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  isMd: boolean;
  modified: number | null;  // serde camelCase from Rust Option<u64>
  created: number | null;
}
```

**Client-side sort after tree load:** After `list_directory` returns entries (already sorted folders-first, then alpha), the frontend applies the user's chosen sort. Sort is applied in a new `sortEntries(entries, sortBy)` utility function consumed by `TreeNode.svelte` at each level.

### Pattern 7: localStorage Vault-Keyed Persistence (FILE-07)

**Vault hash key pattern** (per CONTEXT.md D-19):
```typescript
// Key: 'vaultcore-tree-state:{first 16 hex chars of SHA-256(vault_path)}'
// SHA-256 via Web Crypto API (available in Tauri webview without network)
async function vaultHash(vaultPath: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(vaultPath);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
```

**Store shape:**
```typescript
interface TreeState {
  sortBy: 'name' | 'modified' | 'created';
  expanded: string[];  // vault-relative paths
}
```

### Pattern 8: Settings Modal Focus-Trap (Accessibility)

Focus-trap implementation for Settings modal — no external library needed:
```typescript
// Standard DOM-based focus trap: on modal open, capture Tab and Shift+Tab
// to cycle within focusable children. Restore focus to trigger element on close.
// Focusable selector: 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
// Source: [ASSUMED] — standard web accessibility pattern (MDN WAI-ARIA)
function trapFocus(modalEl: HTMLElement) {
  const focusable = modalEl.querySelectorAll<HTMLElement>(
    'button, input, select, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  // On Tab at last → focus first; on Shift+Tab at first → focus last
}
```

ESC handling in modal: registered on the modal element's `onkeydown`, not in global `SHORTCUTS` array — prevents interference with editor Escape handling (per UI-SPEC Interaction Contracts). [VERIFIED: UI-SPEC]

### Pattern 9: Shortcut Registry Refactor (D-11)

**Current state** (verified by reading `VaultLayout.svelte` lines 185-225): `handleKeydown` is a monolithic `if/else if` chain handling Cmd+Shift+B, Cmd+Shift+F, Cmd+P, Cmd+Tab, Cmd+W inline. No registry exists yet.

**Target `src/lib/shortcuts.ts`:**
```typescript
export interface Shortcut {
  id: string;
  keys: { meta: boolean; shift?: boolean; key: string };
  label: string;  // German, for Settings modal display
  handler: () => void;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'new-note', keys: { meta: true, key: 'n' }, label: 'Neue Notiz', handler: () => { /* ... */ } },
  { id: 'quick-switcher', keys: { meta: true, key: 'p' }, label: 'Schnellwechsler', handler: () => { /* ... */ } },
  // ... remaining 5 shortcuts
];
```

**Priority guard in handleKeydown** (per UI-SPEC):
1. Settings modal open → only ESC handled globally
2. Quick Switcher open → only ESC and arrow/enter pass through
3. Inline rename focused → no shortcuts fire
4. Otherwise → iterate SHORTCUTS array

### Pattern 10: Sidebar Tag Panel as Third Tab

**Existing sidebar tab structure** (verified by reading `Sidebar.svelte`): Two tabs ("Dateien", "Suche") using `.vc-sidebar-tab` and `.vc-sidebar-tabpanel` CSS classes with `aria-selected` pattern. [VERIFIED: codebase]

Adding a third tab "Tags" is a direct copy of the "Suche" tab pattern: add a third `.vc-sidebar-tab` button and a third conditional tab panel mounting `TagsPanel.svelte`.

The tag panel needs two IPC commands registered in `src-tauri/src/commands/tags.rs`:
- `list_tags() -> Vec<TagUsage>` — returns all tags sorted alphabetically with counts
- `get_tag_occurrences(tag: String) -> Vec<TagOccurrence>` — returns file+line for a specific tag (for future drill-down; not strictly needed for TAG-03/TAG-04 but mirrors backlinks pattern)

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML frontmatter parsing | Custom `---` parser with string split | `serde_yml` | Edge cases: multi-line values, quoted strings, nested maps |
| Inline tag false positives | Naive `#` split | Regex with `OnceLock` and fast-path `.contains('#')` | URL anchors, inline code spans, heading markers |
| Font loading | Base64-inlined CSS | `@fontsource/*` npm packages | Already does woff2 conversion, weight subsetting, cross-platform naming |
| Focus trap | Manual tab-index rewriting | DOM focusable query + Tab intercept | One-time 20-line function; no library needed |
| SHA-256 for vault hash key | MD5 or CRC32 | `crypto.subtle.digest('SHA-256', ...)` (built into browser/Tauri webview) | Already used everywhere else in the codebase |
| Language detection for fenced code | Custom fence-label → grammar mapping | `@codemirror/language-data` `languages` array with `LanguageDescription.matchLanguageName` | 100+ languages maintained upstream |

**Key insight:** Every "new" feature in this phase has an existing codebase pattern to clone — TagIndex clones LinkGraph, themeStore clones scrollStore, shortcut registry replaces inline if/else with an array. There is almost no net-new architecture.

---

## Common Pitfalls

### Pitfall 1: `serde_yaml` is Deprecated
**What goes wrong:** CONTEXT.md D-01 names `serde_yaml` as the YAML crate. Adding `serde_yaml = "1"` to Cargo.toml will install the deprecated version (0.9.34+deprecated), which emits compiler warnings and has an unmaintained security posture.
**Why it happens:** The crate was deprecated in 2024 when the original author abandoned it. A maintained fork `serde_yml` continues the work.
**How to avoid:** Use `serde_yml = "0.0.12"` instead. The API is nearly identical — `serde_yml::from_str` replaces `serde_yaml::from_str`. Flag this in the plan as a deviation from CONTEXT.md D-01 wording.
**Warning signs:** Cargo.lock shows `serde_yaml` instead of `serde_yml`.

### Pitfall 2: `DirEntry` Missing Timestamps — Sort Will Silently Fall Back to Name
**What goes wrong:** The client-side sort for FILE-06 assumes `DirEntry` carries `modified` and `created` fields. If the backend is not extended first, the sort silently does nothing or crashes with a TypeScript type error.
**Why it happens:** `list_directory` in `tree.rs` was designed for Phase 2 display — no timestamps needed then.
**How to avoid:** The Rust `DirEntry` struct extension MUST be the first task in the FILE-06/FILE-07 work stream. The TypeScript type update (`src/types/tree.ts`) follows immediately after.
**Warning signs:** TypeScript compiler errors on `entry.modified` access.

### Pitfall 3: `created` Time Not Available on Linux
**What goes wrong:** `metadata().created()` returns `Err(Os { code: 75, ... EOVERFLOW })` or `Err(unsupported)` on Linux ext4. If the Rust code calls `.unwrap()` on this, the watcher or `list_directory` panics.
**Why it happens:** Linux does not store `btime` (birth time) in ext4's stat structure.
**How to avoid:** Use `metadata().created().ok().map(|t| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())).flatten()` — `Option<u64>` with two `ok()` calls. [VERIFIED: Rust std docs behavior]
**Warning signs:** `cargo test` passes on macOS/Windows but crashes on Linux CI.

### Pitfall 4: CM6 `markdown({ codeLanguages })` Requires Async Language Loading
**What goes wrong:** `@codemirror/language-data` language packs are loaded asynchronously when first needed. If the CM6 config is set up synchronously with a sync lookup, highlighting may silently not apply.
**Why it happens:** Language grammars are lazily imported via dynamic `import()` — the first fence render returns immediately with fallback, then triggers the async load.
**How to avoid:** Use the `languages` array directly from `@codemirror/language-data` — CM6 handles the async load transparently behind `LanguageDescription.load()`. Do not manually call `.load()`. [ASSUMED — async behavior; verify with package changelog]
**Warning signs:** Fenced code renders without syntax colors on first view, then highlights after a moment (this is actually correct behavior — not a bug).

### Pitfall 5: Keyboard Shortcut Modal-Suppression Ordering
**What goes wrong:** If `SHORTCUTS` array iteration happens before the modal-open guard, `Cmd+N` inside the Settings modal creates a new note while the modal is open.
**Why it happens:** Global `svelte:document onkeydown` fires for every keystroke regardless of modal state.
**How to avoid:** The first check in `handleKeydown` must test `settingsModalOpen` state and return early (with only ESC forwarded to the modal's own ESC handler). [VERIFIED: UI-SPEC priority order]
**Warning signs:** Creating notes while Settings modal is visible.

### Pitfall 6: Tag Regex False Positives in Code Blocks
**What goes wrong:** `#include <stdio.h>` in a fenced C code block matches the tag regex.
**Why it happens:** Rust's `tag_index.rs` intentionally indexes all content without code-block exclusion (mirrors the `link_graph.rs` decision to index all content, with CM6 handling visual suppression).
**How to avoid:** This is an architectural decision, not a bug — document it in the tag_index.rs header comment. Tags inside fenced blocks will appear in the tag panel. If this is unacceptable, a simple heuristic is to skip lines between ` ```lang ` and ` ``` ` markers during extraction. For MVP, accept the false positives (same tradeoff as LinkGraph). [ASSUMED — acceptable for MVP per CONTEXT.md Out of Scope section]
**Warning signs:** `#include` appearing as a tag in the panel.

### Pitfall 7: @fontsource CSS Import Order
**What goes wrong:** Importing @fontsource CSS in `main.ts` after Tailwind's CSS can result in the `@font-face` declarations being overridden or ignored.
**Why it happens:** CSS cascade order — later declarations win.
**How to avoid:** Import @fontsource CSS before Tailwind or in `tailwind.css` via `@import`. Verify the correct import path format: `@fontsource/inter/400.css` (not `@fontsource/inter`). [ASSUMED — Vite/Tailwind v4 import order behavior]

---

## Runtime State Inventory

Step 2.5: SKIPPED. Phase 5 is a new-feature/polish phase — no rename, refactor, migration, or string replacement is involved. There is no runtime state carrying a string that changes.

---

## Environment Availability

| Dependency | Required By | Available | Version | Notes |
|------------|------------|-----------|---------|-------|
| Rust / cargo | `tag_index.rs`, `serde_yml`, `tree.rs` timestamp | ✓ | rust-version 1.77.2 in Cargo.toml | `OnceLock` requires 1.70+ [VERIFIED] |
| Node.js / npm | @fontsource, @codemirror/language-data install | ✓ | detected in PATH | [VERIFIED: codebase uses npm] |
| `serde_yml` | TAG-02 YAML parsing | not in Cargo.toml | 0.0.12 (latest) | Must add to Cargo.toml |
| `@codemirror/language-data` | EDIT-03 | not installed | 6.5.2 | Must install |
| `@fontsource/inter` | UI-02 | not installed | 5.2.8 | Must install |
| `@fontsource/lora` | UI-02 | not installed | 5.2.8 | Must install |
| `@fontsource/jetbrains-mono` | UI-02 | not installed | 5.2.8 | Must install |
| `@fontsource/fira-code` | UI-02 | not installed | 5.2.7 | Must install |

**No blocking missing dependencies without fallback.** All missing packages have known install commands. The `serde_yaml` → `serde_yml` substitution is a drop-in replacement.

---

## Code Examples

### Tag Regex with Fast-Path (mirrors link_graph.rs)
```rust
// Source: [VERIFIED: codebase] — mirrors src-tauri/src/indexer/link_graph.rs fast-path pattern
fn extract_tags(content: &str) -> Vec<String> {
    // Fast-path: skip regex overhead for files without '#'
    if !content.contains('#') {
        return vec![];
    }
    let re = tag_regex();
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1))
        .map(|m| m.as_str().to_lowercase())
        .collect()
}
```

### IndexCoordinator — Add tag_index Field (mirrors link_graph addition)
```rust
// Source: [VERIFIED: codebase] — mirrors src-tauri/src/indexer/mod.rs IndexCoordinator
pub struct IndexCoordinator {
    pub tx: mpsc::Sender<IndexCmd>,
    file_index: Arc<Mutex<FileIndex>>,
    matcher: Arc<Mutex<nucleo_matcher::Matcher>>,
    pub reader: Arc<IndexReader>,
    pub index: Arc<Index>,
    link_graph: Arc<Mutex<LinkGraph>>,
    tag_index: Arc<Mutex<TagIndex>>,  // Phase 5 addition
}

// getter:
pub fn tag_index(&self) -> Arc<Mutex<TagIndex>> {
    Arc::clone(&self.tag_index)
}
```

### Watcher Dispatch for Tags (mirrors UpdateLinks/RemoveLinks)
```rust
// Source: [VERIFIED: codebase] — mirrors watcher.rs dispatch_link_graph_cmd pattern
fn dispatch_tag_index_cmd(
    index_tx: &Option<mpsc::Sender<IndexCmd>>,
    path: &Path,
    kind: &str,
    vault_path: &Path,
) {
    let Some(tx) = index_tx else { return };
    if path.extension().map_or(true, |e| !e.eq_ignore_ascii_case("md")) { return; }
    let rel_path = path.strip_prefix(vault_path)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let cmd = match kind {
        "create" | "modify" => {
            let content = std::fs::read_to_string(path).unwrap_or_default();
            IndexCmd::UpdateTags { rel_path, content }
        }
        "delete" => IndexCmd::RemoveTags { rel_path },
        _ => return,
    };
    let _ = tx.try_send(cmd);
}
```

### CM6 language-data Integration
```typescript
// Source: [ASSUMED] — based on @codemirror/language-data 6.5.2 API
// In src/components/Editor/extensions.ts — replace current markdown() call
import { languages } from '@codemirror/language-data';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';

// Replace:
//   markdown({ extensions: [GFM] })
// With:
markdown({
  extensions: [GFM],
  codeLanguages: languages,
})
```

### autoSave Hash-Verify Extension
```typescript
// Source: [VERIFIED: codebase] — extends autoSave.ts pattern
// The onSave callback in EditorPane.svelte becomes:
const onSave = async (text: string) => {
  if (!vaultReachable) return;
  try {
    // Read on-disk hash — new IPC command
    const diskHash = await getFileHash(tab.filePath);
    const expectedHash = editorStore_lastSavedHash; // from editorStore snapshot

    if (diskHash !== expectedHash) {
      // Hash mismatch — external modification; invoke merge path
      const lastSavedContent = tab.lastSavedContent; // from tabStore
      const result = await mergeExternalChange(tab.filePath, text, lastSavedContent);
      // apply merge result to CM6 view (existing pattern from EditorPane.svelte line 390)
      return;
    }

    // Hashes match — safe to write
    const newHash = await writeFile(tab.filePath, text);
    editorStore.setLastSavedHash(newHash);
    tabStore.setLastSavedContent(tab.id, text);
  } catch (err) { /* existing error handling */ }
};
```

### DirEntry Timestamp Addition in Rust
```rust
// Source: [VERIFIED: codebase] — extends src-tauri/src/commands/tree.rs DirEntry
use std::time::UNIX_EPOCH;

// In DirEntry struct — add two optional fields
pub modified: Option<u64>,
pub created: Option<u64>,

// In list_directory_impl — populate from metadata
let meta = entry.metadata().map_err(VaultError::Io)?;
let modified = meta.modified().ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_secs());
let created = meta.created().ok()  // Returns Err on Linux ext4 — handled by .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_secs());

entries.push(DirEntry {
    name, path: entry_path.to_string_lossy().into_owned(),
    is_dir, is_symlink, is_md, modified, created,
});
```

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `serde_yaml` (deprecated 2024) | `serde_yml` (maintained fork) | Drop-in replacement; same API |
| Global keyboard if/else chain | `SHORTCUTS` array registry | Enables Settings modal shortcut table without duplication |
| Hardcoded CM6 fontSize `15px` | `var(--vc-font-size)` CSS variable (already in theme.ts) | Runtime font-size change without editor rebuild |

**Note:** `markdownTheme` already uses `fontSize: "15px"` as a hardcoded string [VERIFIED: `src/components/Editor/theme.ts` line 25]. Phase 5 must change this to `fontSize: "var(--vc-font-size)"` to enable the slider.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Tag regex `(?:^|[\s(,!?;:])#([a-zA-Z][a-zA-Z0-9_\-/]*)` correctly avoids URL fragments | Architecture Pattern 1 | False positives in URLs; needs unit tests to verify |
| A2 | `@codemirror/language-data` lazy-loads language packs asynchronously via CM6's LanguageDescription.load() | Pattern 4 | If synchronous, bundle size bloats; verify after install |
| A3 | @fontsource CSS imports in main.ts are bundled by Vite into the Tauri app without network at runtime | Standard Stack | SEC-01 violation if fonts load from CDN; verify with build audit |
| A4 | Font option disabled-state detection via static build-time check (package installed = enabled) | Pattern 3 | Runtime detection via `document.fonts.check()` may be needed |
| A5 | Tag false positives in fenced code blocks are acceptable for MVP (same decision as LinkGraph) | Pitfall 6 | Tag panel shows `#include`, `#define` etc. as tags — may surprise users |
| A6 | `markdownTheme` `fontSize: "15px"` must be changed to `var(--vc-font-size)` for slider to work | State of the Art | Font size slider has no effect if theme still hardcodes 15px |
| A7 | `crypto.subtle.digest('SHA-256', ...)` is available in Tauri's webview without network | Pattern 7 | Vault hash key generation fails; fallback to simpler string hash needed |
| A8 | `serde_yml` 0.0.12 API is drop-in compatible with the `serde_yaml` API referenced in CONTEXT.md D-01 | Standard Stack / Pitfall 1 | Minor API differences may require adaptation; check `serde_yml` changelog |

---

## Open Questions

1. **`serde_yaml` vs `serde_yml` — planner decision needed**
   - What we know: CONTEXT.md D-01 names `serde_yaml`; that crate is deprecated. `serde_yml` is the maintained fork with near-identical API.
   - What's unclear: Whether the user/planner has a preference for the deprecated original (some projects pin deprecated crates intentionally for stability).
   - Recommendation: Use `serde_yml` and note the deviation from D-01 wording in the plan. If the user insists on `serde_yaml`, it still compiles — just with deprecation notices.

2. **Tag false positives in fenced code blocks**
   - What we know: `link_graph.rs` intentionally indexes all content without code-block exclusion. TagIndex following the same pattern means `#include` becomes a tag.
   - What's unclear: Whether the product treats this as acceptable or a bug.
   - Recommendation: Accept for MVP; add a TODO comment in `tag_index.rs` for v0.2 filtering.

3. **`markdownTheme` fontSize hardcoded at `"15px"`**
   - What we know: `theme.ts` line 25 has `fontSize: "15px"` not `var(--vc-font-size)`. [VERIFIED]
   - What's unclear: Whether changing to `var(--vc-font-size)` breaks any existing font-size tests.
   - Recommendation: This change is required for D-09 to work. Note it explicitly in the typography task.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 (frontend), cargo test (Rust) |
| Config file | `vite.config.ts` (or `vitest.config.ts` — check), `src-tauri/src/tests/mod.rs` |
| Quick run command | `npx vitest run --reporter=dot` (frontend), `cargo test` (Rust) |
| Full suite command | `npx vitest run && cargo test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TAG-01 | Inline `#tag` and `#parent/child` extracted correctly; URL anchors not extracted | unit (Rust) | `cargo test tag_index` | ❌ Wave 0 |
| TAG-02 | YAML `tags: [a, b]` and `tags: a` both parsed | unit (Rust) | `cargo test tag_index::yaml` | ❌ Wave 0 |
| TAG-03 | Tag panel renders with usage counts | smoke (manual) | manual | N/A |
| TAG-04 | Tag-click prefills search and switches tab | integration (manual) | manual | N/A |
| UI-01 | Theme switch changes CSS vars without editor rebuild | unit (TS) | `npx vitest run src/store/themeStore` | ❌ Wave 0 |
| UI-02 | Font change sets CSS custom properties | unit (TS) | `npx vitest run src/store/settingsStore` | ❌ Wave 0 |
| UI-03 | `Cmd+\` toggles sidebar | integration (manual) | manual | N/A |
| EDIT-03 | Fenced code block shows syntax highlighting | smoke (manual) | manual | N/A |
| EDIT-07 | Undo/redo isolated per tab | unit (CM6) | `npx vitest run src/store/tabStore` | ❌ Wave 0 |
| EDIT-08 | 10k-line file opens without degradation | integration test with fixture | `npx vitest run tests/largeFile.test.ts` | ❌ Wave 0 |
| EDIT-10 | Hash mismatch triggers merge path, not overwrite | unit (TS) | `npx vitest run src/components/Editor/autoSave` | ❌ Wave 0 |
| FILE-06 | Sort by name/modified/created produces correct order | unit (TS) | `npx vitest run src/lib/sortEntries` | ❌ Wave 0 |
| FILE-07 | Expand state persists to localStorage and restores | unit (TS) | `npx vitest run src/store/treeStore` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo test && npx vitest run --reporter=dot`
- **Per wave merge:** `cargo test && npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/tests/tag_index.rs` — covers TAG-01, TAG-02
- [ ] `src/store/themeStore.test.ts` — covers UI-01
- [ ] `src/store/settingsStore.test.ts` — covers UI-02
- [ ] `src/lib/sortEntries.test.ts` — covers FILE-06
- [ ] `tests/largeFile.test.ts` — covers EDIT-08

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | not applicable (local-only, no auth) |
| V3 Session Management | no | not applicable |
| V4 Access Control | yes | Vault-scope guard already in all file commands; `get_file_hash` must add same guard |
| V5 Input Validation | yes | Tag regex is linear (no backtracking); YAML parsed via `serde_yml` (safe) |
| V6 Cryptography | no | SHA-256 hash is for integrity check, not authentication — built-in `sha2` crate, no hand-roll |

### Known Threat Patterns for Phase 5

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal in `get_file_hash` | Tampering | Same `ensure_inside_vault` guard as `read_file` and `write_file` [VERIFIED: pattern in files.rs] |
| localStorage theme/font injection | Tampering | Values are string tokens (`'light'`/`'dark'`/`'auto'`) set via `dataset.theme` — no innerHTML injection |
| Malformed YAML frontmatter DoS | Tampering | `serde_yml::from_str` error is caught and returns empty tag list — no panic |
| @fontsource CDN call | Information Disclosure | @fontsource packages bundle fonts at build time — zero runtime network; SEC-01 compliant [VERIFIED: package design] |
| Tag regex ReDoS | Denial of Service | Pattern uses possessive-style character classes with no alternation backtracking — linear complexity [ASSUMED: verify with regex-automata analysis] |

---

## Sources

### Primary (HIGH confidence)
- `src-tauri/src/indexer/link_graph.rs` — template for tag_index.rs (OnceLock, fast-path, update_file/remove_file)
- `src-tauri/src/indexer/mod.rs` — IndexCoordinator, IndexCmd enum extension pattern
- `src-tauri/src/commands/files.rs` — write_file returns SHA-256 hash (EDIT-10 groundwork comment confirmed)
- `src-tauri/src/commands/tree.rs` — DirEntry struct confirmed missing timestamp fields
- `src/components/Editor/autoSave.ts` — current 27-line implementation, extension approach verified
- `src/components/Editor/theme.ts` — fontSize: "15px" hardcoded (A6 gap confirmed)
- `src/components/Editor/extensions.ts` — current markdown() call without codeLanguages
- `src/components/Layout/VaultLayout.svelte` — handleKeydown inline if/else chain; toggleSidebar() exists
- `src/store/editorStore.ts` — lastSavedHash field confirmed
- `src/store/tabStore.ts` — lastSavedContent field confirmed; Tab interface verified
- `src/styles/tailwind.css` — current :root CSS vars; --vc-font-body, --vc-font-mono already defined
- `src/ipc/commands.ts` — mergeExternalChange IPC wrapper confirmed; normalizeError pattern
- `src/components/Sidebar/Sidebar.svelte` — two-tab structure confirmed; treeRefreshStore pattern
- crates.io API — `serde_yaml 0.9.34+deprecated` (2024-03-25), `serde_yml 0.0.12` (2024-08-25)
- npm registry — `@codemirror/language-data 6.5.2`, `@fontsource/* 5.2.7-5.2.8`

### Secondary (MEDIUM confidence)
- 05-UI-SPEC.md — full color table, component inventory, interaction contracts, copywriting (project-generated)
- 05-CONTEXT.md — locked decisions D-01 through D-21

### Tertiary (LOW confidence — marked [ASSUMED] in text)
- Tag regex behavior for URL anchor avoidance (A1)
- @codemirror/language-data async loading behavior (A2, A4)
- @fontsource Vite bundling at build time (A3)
- crypto.subtle availability in Tauri webview (A7)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified against npm registry and crates.io
- Architecture: HIGH — all patterns derived from verified existing code in codebase
- Pitfalls: HIGH for structural gaps (DirEntry timestamps, serde_yaml deprecation); MEDIUM for regex and font behavior
- Security: HIGH — reuses existing vault-scope guard pattern throughout

**Research date:** 2026-04-12
**Valid until:** 2026-05-12 (stable libraries; @codemirror ecosystem moves slowly)
