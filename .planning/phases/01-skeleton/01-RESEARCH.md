# Phase 1: Skeleton — Research

**Researched:** 2026-04-11
**Domain:** Tauri 2 + Svelte 5 runes + CodeMirror 6 + Rust backend
**Confidence:** HIGH (core patterns) / MEDIUM (some Tauri v2 capability scoping details)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Svelte 5 runes mode (`$state`, `$derived`, `$effect`) — NOT React
- **D-02:** Plain Svelte + Vite, not SvelteKit
- **D-03/D-04:** Scaffold via `pnpm create tauri-app@latest` with `svelte-ts` template; pnpm as package manager
- **D-05:** `.tsx` filenames from spec → `.svelte`; same directory layout
- **D-06:** Zustand dropped; native Svelte `writable`/`readable`/`derived` stores
- **D-07:** `PROJECT.md` and spec §17 must be updated (Zustand → Svelte stores) — out of Phase 1 scope but noted
- **D-08:** Store files: `src/store/vaultStore.ts`, `src/store/editorStore.ts` only in Phase 1
- **D-09:** `tsconfig.json` maximally strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- **D-10:** Minimal live-preview: `@codemirror/lang-markdown` GFM + CM6 theme for H1/H2/H3 size; bold/italic/code markers stay visible
- **D-11:** Hide-markers-on-non-active-lines deferred
- **D-12:** HyperMD-style atomic widgets deferred to Phase 5+
- **D-13:** CM6 extension stack: `lang-markdown` (GFM) + `basicSetup` + custom keymap (Mod+B/I/K) + Tailwind CSS variable theme (CSS vars, not hardcoded hex)
- **D-14:** No sidebar in Phase 1; post-vault-open shows flat alphabetical list of all `.md` files; click → editor; code thrown away in Phase 2
- **D-15:** Auto-load last vault does NOT reopen last-edited file
- **D-16:** EDIT-11 (Cmd+N) deferred to Phase 5
- **D-17:** Non-UTF-8 files: `read_file` returns `VaultError::InvalidEncoding`, frontend shows toast, file not loaded
- **D-18:** Lean scaffold only: specific folders listed in CONTEXT.md (see Architecture Patterns section)
- **D-19:** Cargo.toml Phase 1 deps: `tauri` v2, `serde`, `serde_json`, `thiserror`, `sha2`, `walkdir`, `tokio`, `log`, `env_logger` — no `tantivy`/`notify`/`pulldown-cmark`/`regex`/`rayon`/`fuzzy-matcher`/`similar`/`chrono`
- **D-20:** Tauri v2 plugins: `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs` only
- **D-21:** IDX-02 = real file-walk emitting `vault://index_progress` Tauri events `{ current, total, current_file }`; no hardcoded animation
- **D-22:** Two-pass: first pass counts total, second pass emits progress
- **D-23:** Recent vaults: `recent-vaults.json` in `appDataDir()`, schema `{ vaults: [{ path, last_opened }] }`, cap 10, evict oldest

### Claude's Discretion

- Welcome screen visual layout (centered card vs hero, exact copy, recent-list item format)
- Light theme exact CM6 color values (must use Tailwind CSS variables)
- Progress UI emit cadence (every N files, every M ms, or both)
- Test stack details (Vitest + `cargo test` specifics)
- Lint/format tooling (eslint + prettier, rustfmt + clippy)
- Toast component visual (must support error/clean-merge/conflict variants per UI-04)
- Tauri event naming convention (pick one, stay consistent)

### Deferred Ideas (OUT OF SCOPE)

- Hide-markers live-preview (Obsidian-style)
- HyperMD atomic widgets
- Last-edited file persistence per vault
- Cmd+N new file (EDIT-11)
- Dark mode (UI-01)
- Window state persistence
- CI setup
- License file
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VAULT-01 | User can open a vault folder via native OS folder picker | §1: `@tauri-apps/plugin-dialog` `open({ directory: true })`; capabilities `dialog:allow-open` |
| VAULT-02 | Recent-vaults list persisted as JSON in Tauri app-data directory | §4: `appDataDir()` from `@tauri-apps/api/path`; `plugin-fs` write; `mkdir({ recursive: true })` on first run |
| VAULT-03 | On startup, last opened vault auto-loads if still reachable | §1: on-mount check of `recent-vaults.json`, call `open_vault`, fall back to Welcome on `VaultUnavailable` |
| VAULT-04 | Welcome screen with "Open vault" button + recent list when no vault open | §1: conditional render in `App.svelte` based on `vaultStore` state |
| VAULT-05 | If last vault unreachable → Welcome screen without crashing + toast | §2: `VaultError::VaultUnavailable` returned from `open_vault`, frontend catches and shows toast |
| VAULT-06 | `VaultStats` command surfaces vault path and note count | §1: `get_vault_stats` command returning `{ path, file_count }` after walkdir count |
| IDX-02 | Progress bar with filename and counter fed by Tauri events | §2: `AppHandle::emit("vault://index_progress", payload)` in walkdir loop; frontend `listen()` |
| EDIT-01 | CM6 Markdown syntax highlighting (headings, bold, italic, code, lists, tables) | §3: `markdown({ extensions: [GFM] })` + `syntaxHighlighting(HighlightStyle.define([...]))` |
| EDIT-02 | Inline live-preview of bold, italic, headings, inline code, lists | §3: D-10 minimal slice — theme-based size changes for headings; markers remain visible |
| EDIT-04 | Keyboard shortcuts: Cmd/Ctrl+B/I/K wrap selection | §3: `keymap.of([{ key: 'Mod-b', run: wrapBold }, ...])` + `wrapSelection` helper |
| EDIT-09 | Auto-save writes active note every 2 s (no manual save, no dirty indicator) | §3: spec §6.4 says "alle 2 Sekunden" = fixed 2s; debounce on `docChanged` resets 2s timer |
| UI-04 | Toast: error/clean-merge/conflict variants, auto-dismiss 5s, manually dismissable | §2: Toast component with variant discriminator; driven by `VaultError` or explicit event type |
| ERR-01 | `VaultError` enum with all spec §5 variants + `InvalidEncoding` | §2: `thiserror` enum + manual `serde::Serialize` with `#[serde(tag="kind")]` for discriminated frontend objects |
</phase_requirements>

---

## Summary

- Tauri v2 with the `svelte-ts` template generates a clean scaffold via `pnpm create tauri-app --name vaultcore --template svelte-ts --manager pnpm`; post-scaffold requires stripping demo code, adding plugin crates to Cargo.toml, and wiring capabilities. The generated layout matches D-18 closely after minimal trimming.
- The key Rust pattern for `VaultError` is `thiserror` enum + manual `impl serde::Serialize` using a struct serializer with `kind`/`message`/`data` fields so the frontend receives a typed discriminated object, not a string.
- CodeMirror 6 mounts into a plain DOM element via `onMount` in a Svelte component; the `EditorView` instance should be stored in a plain `let` (not `$state`) to avoid reactive overhead; content updates go through `view.dispatch({ changes: ... })`.
- `basicSetup` is acceptable for Phase 1 (it is tree-shakeable via Vite); the bundle cost is acceptable for a desktop Tauri app where download size is less critical than latency.
- Svelte 5 classic `writable` stores remain fully supported in runes-mode components via `$store` auto-subscription syntax; D-06 is safe to implement as specified — no CONTEXT reconsideration needed.

**Primary recommendation:** Follow D-18 scaffold inventory exactly; implement `VaultError` with structured serde serialization from day 1; store `EditorView` as a plain `let` (not reactive); use `onMount`/`onDestroy` (not `$effect`) for CM6 lifecycle to keep DOM side-effects predictable.

---

## 1. Tauri 2 Scaffolding

### 1.1 Exact Scaffold Command

[VERIFIED: npm registry, create-tauri-app 4.6.2]

```bash
pnpm create tauri-app --name vaultcore --template svelte-ts --manager pnpm
```

Non-interactive flags: `--name`, `--template`, `--manager`. To scaffold in the current directory use `.` as the name. If the tool prompts despite flags (version-dependent), the interactive answers are: project name = `vaultcore`, package manager = `pnpm`, frontend template = `svelte-ts`.

### 1.2 Generated Structure vs. Target (D-18)

[VERIFIED: v2.tauri.app/start/project-structure/]

The scaffold produces approximately:

```
vaultcore/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/
│   ├── main.ts         # entry point
│   ├── App.svelte      # demo component — STRIP
│   ├── lib/
│   │   └── Greet.svelte  # demo — STRIP
│   └── styles.css      # rename / replace with tailwind.css
└── src-tauri/
    ├── Cargo.toml
    ├── Cargo.lock
    ├── build.rs
    ├── tauri.conf.json
    ├── src/
    │   ├── main.rs
    │   └── lib.rs
    ├── icons/
    │   └── (platform icons)
    └── capabilities/
        └── default.json
```

**Post-scaffold actions required:**
1. Strip `src/lib/Greet.svelte`, clear demo content from `src/App.svelte`
2. Replace `src/styles.css` with `src/styles/tailwind.css` (update import in `index.html` and `main.ts`)
3. Create directories per D-18: `src/components/Welcome/`, `src/components/Editor/`, `src/components/Toast/`, `src/components/Progress/`, `src/store/`, `src/ipc/`
4. Create `src-tauri/src/error.rs`, `src-tauri/src/commands/` (vault.rs, files.rs, mod.rs)
5. Add plugin crates to `Cargo.toml` (see §1.4)
6. Replace `src-tauri/capabilities/default.json` with VaultCore capability set (see §1.5)
7. Configure `tsconfig.json` for D-09 strict settings

### 1.3 Tailwind CSS Setup in Plain Vite+Svelte

[CITED: tailwindcss.com/docs] [ASSUMED: Tailwind 4 may differ from v3 — verify with `npm view tailwindcss version`]

Current Tailwind is 4.2.2. [VERIFIED: npm registry]. Tailwind 4 uses a CSS-first config (no `tailwind.config.js` needed by default):

```bash
pnpm add -D tailwindcss @tailwindcss/vite
```

Add to `vite.config.ts`:
```typescript
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
})
```

In `src/styles/tailwind.css`:
```css
@import "tailwindcss";

/* CSS variables for CM6 theme (D-13 requirement) */
:root {
  --vc-bg: #ffffff;
  --vc-fg: #1a1a1a;
  --vc-heading-1-size: 1.6em;
  --vc-heading-2-size: 1.4em;
  --vc-heading-3-size: 1.2em;
  --vc-keyword: #7c3aed;
  --vc-string: #059669;
  --vc-comment: #6b7280;
}
```

Phase 5 dark mode swap: add `[data-theme="dark"] { --vc-bg: #1a1a1a; ... }` — no Tailwind rewrite needed.

### 1.4 Rust Plugin Registration

[VERIFIED: v2.tauri.app/plugin/dialog/, v2.tauri.app/plugin/file-system/]

Add to `Cargo.toml`:
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
sha2 = "0.10"
walkdir = "2"
tokio = { version = "1", features = ["full"] }
log = "0.4"
env_logger = "0.11"
```

Note: `thiserror` latest is v2. [VERIFIED: npm/crates search] Use `thiserror = "2"` (breaking changes from v1 are minimal for our usage pattern).

In `src-tauri/src/lib.rs`:
```rust
pub fn run() {
    env_logger::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::vault::open_vault,
            commands::vault::get_recent_vaults,
            commands::vault::get_vault_stats,
            commands::files::read_file,
            commands::files::write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application")
}
```

Frontend install:
```bash
pnpm add @tauri-apps/plugin-dialog @tauri-apps/plugin-fs
```

### 1.5 Tauri v2 Capabilities JSON

[VERIFIED: v2.tauri.app/learn/security/using-plugin-permissions/]

`src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-capability",
  "description": "VaultCore Phase 1 capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "fs:allow-exists",
    "fs:allow-create-dir",
    {
      "identifier": "fs:scope",
      "allow": [
        { "path": "$APPDATA" },
        { "path": "$APPDATA/**" }
      ]
    }
  ]
}
```

**Critical:** The `fs:scope` static capability only covers `$APPDATA` (for `recent-vaults.json`). User-selected vault folders need **runtime scope expansion** in the Rust `open_vault` command using `FsExt`:

```rust
use tauri_plugin_fs::FsExt;

#[tauri::command]
pub async fn open_vault(
    app: tauri::AppHandle,
    path: String,
) -> Result<VaultInfo, VaultError> {
    // Expand FS scope to allow reading/writing files inside the picked folder
    app.fs_scope()
        .allow_directory(&path, true) // true = recursive
        .map_err(|e| VaultError::Io(e))?;
    // ... rest of implementation
}
```

[MEDIUM confidence: FsExt::allow_directory is documented in Tauri plugin-fs Rust docs; the exact error mapping may need adjustment]

### 1.6 `tsconfig.json` Strict Settings (D-09)

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true
  }
}
```

**Gotcha:** `exactOptionalPropertyTypes` causes false-positive errors on properties set to `undefined` in object literals. Be precise: `prop?: string` means the key is absent, not `prop: string | undefined`. This is stricter than most TypeScript users expect.

---

## 2. Tauri 2 Commands, Events, and Error Serialization

### 2.1 VaultError Enum with Structured Serialization

[VERIFIED: v2.tauri.app/develop/calling-rust/]

The Tauri-recommended pattern serializes errors as strings. For VaultCore, we need discriminated objects so the frontend can branch on `error.kind`. Use manual `serde::Serialize` with a struct serializer:

`src-tauri/src/error.rs`:
```rust
use serde::ser::SerializeStruct;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("File not found: {path}")]
    FileNotFound { path: String },

    #[error("Permission denied: {path}")]
    PermissionDenied { path: String },

    #[error("Disk full")]
    DiskFull,

    #[error("Index corrupt, rebuild needed")]
    IndexCorrupt,

    #[error("Vault unavailable: {path}")]
    VaultUnavailable { path: String },

    #[error("Merge conflict: {path}")]
    MergeConflict { path: String },

    #[error("File is not UTF-8: {path}")]
    InvalidEncoding { path: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for VaultError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("VaultError", 3)?;
        state.serialize_field("kind", &self.variant_name())?;
        state.serialize_field("message", &self.to_string())?;
        state.serialize_field("data", &self.extra_data())?;
        state.end()
    }
}

impl VaultError {
    fn variant_name(&self) -> &'static str {
        match self {
            Self::FileNotFound { .. } => "FileNotFound",
            Self::PermissionDenied { .. } => "PermissionDenied",
            Self::DiskFull => "DiskFull",
            Self::IndexCorrupt => "IndexCorrupt",
            Self::VaultUnavailable { .. } => "VaultUnavailable",
            Self::MergeConflict { .. } => "MergeConflict",
            Self::InvalidEncoding { .. } => "InvalidEncoding",
            Self::Io(_) => "Io",
        }
    }

    fn extra_data(&self) -> Option<String> {
        match self {
            Self::FileNotFound { path }
            | Self::PermissionDenied { path }
            | Self::VaultUnavailable { path }
            | Self::MergeConflict { path }
            | Self::InvalidEncoding { path } => Some(path.clone()),
            _ => None,
        }
    }
}
```

Frontend receives:
```typescript
// { kind: "VaultUnavailable", message: "Vault unavailable: /path", data: "/path" }
interface VaultError {
  kind:
    | "FileNotFound" | "PermissionDenied" | "DiskFull"
    | "IndexCorrupt" | "VaultUnavailable" | "MergeConflict"
    | "InvalidEncoding" | "Io";
  message: string;
  data: string | null;
}
```

`src/ipc/commands.ts` wrapper pattern:
```typescript
import { invoke } from '@tauri-apps/api/core';
import type { VaultError } from '../types/errors';

export async function openVault(path: string): Promise<VaultInfo> {
  return invoke<VaultInfo>('open_vault', { path });
  // throws VaultError on Err — catch at call site
}
```

### 2.2 Emitting Events from Rust (AppHandle::emit)

[VERIFIED: v2.tauri.app/develop/calling-frontend/]

```rust
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
pub struct IndexProgressPayload {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

// Inside the walkdir command handler:
app.emit("vault://index_progress", IndexProgressPayload {
    current: i,
    total,
    current_file: entry_path,
}).unwrap(); // safe to unwrap — only fails if window is closed
```

**Event naming convention chosen:** `vault://index_progress` — namespace-style with `://` separator, as specified in D-21. This is not a URL; it is a string key. Tauri v2 imposes no restrictions on event name format beyond being a valid string. [VERIFIED: Tauri docs show kebab-case examples like `download-started`; namespace-style is also valid]

**Frontend listener:**
```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

let unlisten: UnlistenFn | null = null;

onMount(async () => {
  unlisten = await listen<IndexProgressPayload>('vault://index_progress', (event) => {
    // update store with event.payload
  });
});

onDestroy(() => {
  unlisten?.();
});
```

### 2.3 Throttling IDX-02 Progress Events (D-21)

[ASSUMED: no single authoritative Tauri community standard for this; pattern derived from common practice]

Two strategies are viable. Recommend **time-based throttling** (simpler, more responsive on vaults with varying file-size distributions):

```rust
use std::time::{Duration, Instant};

let mut last_emit = Instant::now();
let throttle = Duration::from_millis(50); // ~20 fps max

for (i, entry) in walker.enumerate() {
    // process entry...
    if last_emit.elapsed() >= throttle || i == total - 1 {
        app.emit("vault://index_progress", IndexProgressPayload {
            current: i + 1,
            total,
            current_file: relative_path,
        }).ok();
        last_emit = Instant::now();
    }
}
```

50 ms throttle = max 20 events/second. On a 100k-file vault at Phase 1 speeds (pure walkdir, no parsing), this is well within IPC budget. Phase 3 can tune when real Tantivy work adds latency per file.

**First-pass count (D-22):**
```rust
let total = WalkDir::new(&vault_path)
    .into_iter()
    .filter_map(|e| e.ok())
    .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
    .count();
// second pass with progress events
```

Memory cost: `WalkDir` streams entries; no Vec allocation. [VERIFIED: walkdir crate docs — iterator-based, constant memory]

---

## 3. CodeMirror 6 in Svelte 5

### 3.1 Mount/Unmount Pattern

[VERIFIED: svelte.dev/docs/svelte/lifecycle-hooks, codemirror.net/docs/guide/]

Use `onMount` (not `$effect`) for DOM manipulation. CM6 requires a real DOM element reference:

```svelte
<!-- src/components/Editor/CMEditor.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { buildExtensions } from './extensions';

  let { content, onSave }: { content: string; onSave: (text: string) => void } = $props();

  let container: HTMLDivElement;
  let view: EditorView; // plain let, NOT $state — avoids reactive overhead on the CM6 instance

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: buildExtensions(onSave),
      }),
      parent: container,
    });
  });

  onDestroy(() => {
    view?.destroy();
  });
</script>

<div bind:this={container} class="w-full h-full"></div>
```

**Why plain `let` not `$state` for `view`:** `$state` wraps objects in a Proxy for deep reactivity. `EditorView` is a complex class with internal mutable state — proxying it would break CM6's internal change detection and produce unpredictable behavior. [HIGH confidence — this is a documented CM6 + reactive framework gotcha]

**`$effect` vs `onMount` for CM6:** Prefer `onMount` because `$effect` runs in a microtask that may fire before the DOM is ready in some edge cases, and `onDestroy` is more explicit about cleanup order. [MEDIUM confidence — both work, but `onMount` is the documented Svelte pattern for this use case]

### 3.2 Pushing New Content into an Existing EditorView

[CITED: codemirror.net/docs/guide/ — transactions]

When switching files (click on flat file list → load new content):

```typescript
// Replace entire document content
view.dispatch({
  changes: {
    from: 0,
    to: view.state.doc.length,
    insert: newContent,
  },
  // Optionally reset selection to start of doc
  selection: { anchor: 0 },
});
```

**On undo history:** Replacing the entire document via a transaction DOES add to undo history by default. This is probably wrong for a file-switch — the user should not be able to Cmd+Z back to another file's content. To reset history:

```typescript
import { EditorState } from '@codemirror/state';

view.setState(EditorState.create({
  doc: newContent,
  extensions: buildExtensions(onSave), // rebuild extension set
}));
```

Use `setState` for file switches (clears history). Use `dispatch({ changes })` for external edits within the same file session (Phase 5 merge path preserves history).

### 3.3 Heading Highlight Style (D-10)

[VERIFIED: codemirror.net/examples/styling/]

```typescript
// src/components/Editor/extensions.ts
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const markdownHighlightStyle = HighlightStyle.define([
  // Headings: use CSS variables per D-13
  {
    tag: tags.heading1,
    fontSize: 'var(--vc-heading-1-size)',
    fontWeight: 'bold',
  },
  {
    tag: tags.heading2,
    fontSize: 'var(--vc-heading-2-size)',
    fontWeight: 'bold',
  },
  {
    tag: tags.heading3,
    fontSize: 'var(--vc-heading-3-size)',
    fontWeight: 'bold',
  },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, fontFamily: 'monospace' },
  { tag: tags.link, color: 'var(--vc-link)' },
  { tag: tags.comment, color: 'var(--vc-comment)', fontStyle: 'italic' },
]);

export const markdownTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--vc-bg)',
    color: 'var(--vc-fg)',
    height: '100%',
    fontFamily: 'inherit',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { padding: '1rem' },
  '.cm-line': { lineHeight: '1.6' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--vc-bg) 90%, var(--vc-fg) 10%)' },
});
```

**Extension assembly:**
```typescript
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { vaultKeymap } from './keymap';

export function buildExtensions(onSave: (text: string) => void) {
  return [
    basicSetup,
    markdown({ extensions: [GFM] }),
    syntaxHighlighting(markdownHighlightStyle),
    markdownTheme,
    keymap.of(vaultKeymap),
    autoSaveExtension(onSave),
  ];
}
```

### 3.4 Keyboard Shortcuts: Wrap Selection (D-13, EDIT-04)

[CITED: discuss.codemirror.net/t/keymap-for-bold-text-in-lang-markdown/3150]

```typescript
// src/components/Editor/keymap.ts
import { KeyBinding } from '@codemirror/view';
import { StateCommand } from '@codemirror/state';

function wrapSelection(prefix: string, suffix: string): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => {
      // Check if already wrapped — toggle behavior
      const before = state.sliceDoc(range.from - prefix.length, range.from);
      const after = state.sliceDoc(range.to, range.to + suffix.length);

      if (before === prefix && after === suffix) {
        // Remove wrapping
        return {
          changes: [
            { from: range.from - prefix.length, to: range.from, insert: '' },
            { from: range.to, to: range.to + suffix.length, insert: '' },
          ],
          range: EditorSelection.range(
            range.from - prefix.length,
            range.to - prefix.length,
          ),
        };
      }

      // Add wrapping
      return {
        changes: [
          { from: range.from, insert: prefix },
          { from: range.to, insert: suffix },
        ],
        range: EditorSelection.range(
          range.from + prefix.length,
          range.to + prefix.length,
        ),
      };
    });

    dispatch(state.update(changes, { scrollIntoView: true }));
    return true;
  };
}

// Cmd/Ctrl+K inserts [selection](url) — simplified for Phase 1 (no URL prompt yet)
const wrapLink: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || 'link text';
    const insert = `[${text}](url)`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true }));
  return true;
};

export const vaultKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: wrapSelection('**', '**') },
  { key: 'Mod-i', run: wrapSelection('*', '*') },
  { key: 'Mod-k', run: wrapLink },
];
```

Import `EditorSelection` from `@codemirror/state`.

### 3.5 Auto-Save: Fixed 2s Idle Timer (EDIT-09)

**Spec §6.4 interpretation:** "Automatisches Speichern alle 2 Sekunden" — this is a **2-second idle debounce** (save 2s after the last keystroke), not a repeating interval timer that fires regardless. Evidence: spec also says "kein Dirty-State-Indikator nötig" — an interval timer would require tracking whether content changed between fires; a debounce is cleaner and matches "auto-save after 2s" semantically.

[MEDIUM confidence — spec wording is ambiguous; this interpretation matches the success criterion "User edits the file, waits ~2 seconds, and sees the change on disk"]

```typescript
// src/components/Editor/extensions.ts
import { EditorView } from '@codemirror/view';

function autoSaveExtension(onSave: (text: string) => void) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;

    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      onSave(update.view.state.doc.toString());
      saveTimer = null;
    }, 2000);
  });
}
```

The `onSave` callback in the parent Svelte component calls `invoke('write_file', { path: activePath, content })`.

**Note on `basicSetup`:** `basicSetup` includes `autocompletion()` which ships a ~15 KB chunk. For a desktop Tauri app this is negligible. Vite tree-shakes unused completions sources. [HIGH confidence — acceptable for Phase 1; Phase 6 can audit if RAM budget is tight]

---

## 4. Filesystem and Persistence

### 4.1 walkdir Filtering Pattern (D-14, D-18)

[VERIFIED: docs.rs/walkdir/latest/walkdir/]

```rust
use walkdir::{DirEntry, WalkDir};

fn is_excluded(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_str().unwrap_or("");
    // Skip hidden directories and known non-vault dirs
    matches!(name, ".git" | ".obsidian" | "node_modules" | ".trash")
        || name.starts_with('.')
}

fn walk_md_files(vault_path: &str) -> impl Iterator<Item = walkdir::DirEntry> {
    WalkDir::new(vault_path)
        .follow_links(false)  // spec: symlinks displayed but not followed
        .into_iter()
        .filter_entry(|e| !is_excluded(e))
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().map_or(false, |ext| ext == "md")
        })
}
```

**Hidden dir skipping note:** CONTEXT.md doesn't explicitly say to skip all dotfiles, but spec §6.7 says `.obsidian/` is hidden from browser/indexer. The safe default is to skip all hidden directories (`.git`, `.obsidian`, etc.) — this matches Obsidian's behavior. [MEDIUM confidence — CONTEXT is silent; skipping all dot-prefixed dirs is the conservative choice]

**Memory cost on 100k files:** `WalkDir` is a streaming iterator backed by an OS `readdir` call. It does NOT load the full directory into memory. Each `DirEntry` is ~200 bytes. Processing one at a time: constant memory. [VERIFIED: walkdir crate docs — depth-first streaming]

**Symlink handling:** `follow_links(false)` is the default. Symlinks appear as entries but are not traversed. This matches FILE-08 / D-15. [VERIFIED: walkdir docs]

### 4.2 Non-UTF-8 Detection (D-17)

[VERIFIED: Rust std docs] [ASSUMED: `simdutf8` overkill for Phase 1]

Standard library is sufficient for Phase 1:

```rust
#[tauri::command]
pub async fn read_file(path: String) -> Result<String, VaultError> {
    let bytes = std::fs::read(&path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
            std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
            _ => VaultError::Io(e),
        })?;

    String::from_utf8(bytes)
        .map_err(|_| VaultError::InvalidEncoding { path })
}
```

`std::str::from_utf8` / `String::from_utf8` are O(n) SIMD-accelerated on most platforms in recent Rust (1.75+). For Phase 1, this is fine. Phase 3 could add `simdutf8` for indexing hot paths if benchmarks show UTF-8 validation as a bottleneck. [ASSUMED: performance sufficient for Phase 1]

### 4.3 SHA-256 Hash Pattern for EDIT-10 Groundwork (D-19)

[VERIFIED: docs.rs/sha2]

```rust
use sha2::{Sha256, Digest};

pub fn hash_content(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

// One-liner alternative:
pub fn hash_content_simple(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}
```

**Minimal wiring for Phase 1 groundwork:** `editorStore` keeps a `loadedHash: string` set when a file is read. `write_file` computes the hash of content-to-write and stores it so Phase 5's EDIT-10 can compare on next save. Phase 1 does NOT implement the hash mismatch detection — just establishes the hash-compute pattern.

```rust
#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), VaultError> {
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path },
            _ => VaultError::Io(e),
        })?;
    Ok(())
}
// Phase 5 will extend this to accept an expected_hash param and perform comparison
```

### 4.4 `appDataDir()` and `recent-vaults.json` Persistence (D-23)

[VERIFIED: v2.tauri.app/reference/javascript/api/namespacepath/]

Import path in Tauri v2 (CHANGED from v1):
```typescript
// v2 — correct
import { appDataDir, join } from '@tauri-apps/api/path';

// v1 — WRONG in v2
// import { appDataDir } from '@tauri-apps/api';
```

First-run creation:
```typescript
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

const RECENT_VAULTS_FILENAME = 'recent-vaults.json';
const MAX_RECENT = 10;

interface RecentVault {
  path: string;
  last_opened: string; // ISO-8601
}

interface RecentVaultsFile {
  vaults: RecentVault[];
}

export async function getRecentVaultsFilePath(): Promise<string> {
  const dataDir = await appDataDir();
  // Tauri creates appDataDir automatically; no manual mkdir needed
  return join(dataDir, RECENT_VAULTS_FILENAME);
}

export async function loadRecentVaults(): Promise<RecentVault[]> {
  const filePath = await getRecentVaultsFilePath();
  const fileExists = await exists(filePath);
  if (!fileExists) return [];
  const raw = await readTextFile(filePath);
  const data: RecentVaultsFile = JSON.parse(raw);
  return data.vaults ?? [];
}

export async function pushRecentVault(path: string): Promise<void> {
  const filePath = await getRecentVaultsFilePath();
  let vaults = await loadRecentVaults();
  // Remove existing entry for same path
  vaults = vaults.filter(v => v.path !== path);
  // Prepend (most recent first)
  vaults.unshift({ path, last_opened: new Date().toISOString() });
  // Cap at 10
  if (vaults.length > MAX_RECENT) vaults = vaults.slice(0, MAX_RECENT);
  await writeTextFile(filePath, JSON.stringify({ vaults }, null, 2));
}
```

**First run — does `appDataDir` exist?** Tauri automatically creates the app data directory at first launch. No manual `mkdir` needed for the directory itself. The JSON file must be created on first write (handled by `writeTextFile` which creates missing files). [MEDIUM confidence — Tauri docs state the platform app data dir is created by the OS/framework; verify behavior on Linux if it doesn't exist]

---

## 5. Svelte 5 Runes + Stores

### 5.1 Classic Stores Compatibility in Runes Mode

[VERIFIED: svelte.dev/docs/svelte/stores]

Classic `writable`/`readable`/`derived` stores **fully work** in Svelte 5 runes mode. The `$store` auto-subscription syntax is unchanged. D-06 is valid as specified.

```svelte
<script lang="ts">
  import { vaultStore } from '../../store/vaultStore';

  // $vaultStore is auto-subscribed — no manual subscribe/unsubscribe needed
  const { currentPath } = $vaultStore;
</script>

{#if $vaultStore.currentPath}
  <!-- vault view -->
{:else}
  <WelcomeScreen />
{/if}
```

**Svelte 5 recommendation note:** Svelte 5 docs say "for creating cross-component reactive states, leverage runes instead of stores." The class-based `$state` pattern in `.svelte.ts` files is more idiomatic in Svelte 5. However, D-06 explicitly locks `writable` stores, so this is informational only — not a reconsideration (see CONTEXT Reconsiderations section).

### 5.2 Store Typing Pattern (D-08)

```typescript
// src/store/vaultStore.ts
import { writable, derived } from 'svelte/store';

export interface VaultState {
  currentPath: string | null;
  status: 'idle' | 'opening' | 'indexing' | 'ready' | 'error';
  fileList: string[]; // Phase 1: flat list of relative paths
  errorMessage: string | null;
}

const _vaultStore = writable<VaultState>({
  currentPath: null,
  status: 'idle',
  fileList: [],
  errorMessage: null,
});

// Expose as readable + typed actions
export const vaultStore = {
  subscribe: _vaultStore.subscribe,
  openVault(path: string): void {
    _vaultStore.update(s => ({ ...s, status: 'opening', currentPath: path }));
  },
  setFileList(files: string[]): void {
    _vaultStore.update(s => ({ ...s, fileList: files, status: 'ready' }));
  },
  setError(message: string): void {
    _vaultStore.update(s => ({ ...s, status: 'error', errorMessage: message }));
  },
  reset(): void {
    _vaultStore.set({ currentPath: null, status: 'idle', fileList: [], errorMessage: null });
  },
};
```

```typescript
// src/store/editorStore.ts
import { writable } from 'svelte/store';

export interface EditorState {
  activePath: string | null;
  content: string;
  lastSavedHash: string | null;
}

const _editorStore = writable<EditorState>({
  activePath: null,
  content: '',
  lastSavedHash: null,
});

export const editorStore = {
  subscribe: _editorStore.subscribe,
  openFile(path: string, content: string): void {
    _editorStore.set({ activePath: path, content, lastSavedHash: null });
  },
  setHash(hash: string): void {
    _editorStore.update(s => ({ ...s, lastSavedHash: hash }));
  },
};
```

### 5.3 HMR Behavior with Svelte Stores

[VERIFIED: Svelte HMR documentation / community findings]

When `tauri dev` triggers an HMR reload of a component, component-local `$state` is lost but external store state PERSISTS (stores live outside the component module boundary). This means `vaultStore` and `editorStore` survive HMR cycles — the vault does not need to be re-opened after every frontend edit during development. [HIGH confidence — core Vite HMR behavior]

**Rust state on HMR:** Tauri's Rust backend is NOT restarted on frontend HMR reloads. Rust `State<T>` (e.g., opened vault path in Rust-side state) persists across frontend reloads. Only a full `tauri dev` restart resets Rust state. [ASSUMED: standard Tauri dev behavior; not a known issue]

### 5.4 `$store` vs `get(store)` in Runes Context

- `$vaultStore` in a `.svelte` component file: reactive, auto-subscribes. Use this for template bindings.
- `get(vaultStore)` (from `svelte/store`): one-shot read, no subscription. Use this in event handlers and `async` functions where you need the current value but don't need reactivity.
- `$derived(() => $vaultStore.currentPath)`: creates a derived reactive value in a runes `.svelte` file. Rarely needed when using stores directly.

---

## 6. CLAUDE.md / Skills Constraints

### 6.1 Project Skills

[VERIFIED: filesystem check] No `.claude/skills/` or `.agents/skills/` directories exist. No skill files affect Phase 1.

### 6.2 CLAUDE.md Constraints

From `./CLAUDE.md`:

| Directive | Impact on Phase 1 |
|-----------|-------------------|
| Tech stack locked: Tauri 2 + Rust + CM6 + Svelte + Tantivy + Zustand | D-06 supersedes Zustand; rest locked |
| Cold start < 3s | Phase 1 sets the baseline; basicSetup + lang-markdown adds ~200KB JS (gzipped ~60KB) — acceptable for desktop |
| Keystroke latency < 16ms | CM6's updateListener fires synchronously; debounce is outside the render path — no latency risk |
| RAM idle < 100MB | Phase 1 has no indexer; only walkdir (streaming) and CM6 in memory. Risk: None in Phase 1 |
| Zero network calls | `plugin-fs` is local-only; no network APIs used |
| Zero telemetry | No analytics imported; scaffolded Svelte template has none |
| GSD workflow enforcement | Use `/gsd-execute-phase` for implementation; no direct edits outside GSD |

### 6.3 `basicSetup` Bundle Impact

`basicSetup` from `codemirror` package includes: lineNumbers, highlightActiveLineGutter, highlightSpecialChars, history, foldGutter, drawSelection, dropCursor, allowMultipleSelections, indentOnInput, defaultHighlightStyle, bracketMatching, closeBrackets, autocompletion, rectangularSelection, crosshairCursor, highlightActiveLine, highlightSelectionMatches, and a full keymap. [VERIFIED: github.com/codemirror/basic-setup]

**Risk:** `autocompletion()` and `foldGutter()` are included but not needed in Phase 1. Vite's tree-shaking removes unused completion sources but not the extension registrations themselves.

**Decision (Claude's Discretion):** Keep `basicSetup` for Phase 1 — it provides undo history, bracket matching, and search keybindings that make the editor feel complete from day 1. The ~200KB total CM6 bundle is negligible for a desktop app targeting RAM < 100MB idle. Phase 6 can audit if needed.

---

## 7. Validation Architecture

Nyquist validation is enabled (absent from config = enabled per research protocol).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 + @testing-library/svelte 5.3.1 |
| Rust tests | `cargo test` (built-in) |
| Config file | `vitest.config.ts` (Wave 0 gap — doesn't exist yet) |
| Quick run command | `pnpm vitest run` |
| Full suite command | `pnpm vitest run && cargo test` |

**Vitest setup for Svelte 5 + jsdom:**
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
  },
  resolve: process.env.VITEST
    ? { conditions: ['browser'] }
    : undefined,
});
```

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VAULT-01 | Native folder picker invoked + path returned | Manual + Vitest mock | `pnpm vitest run tests/vault.test.ts` | Wave 0 gap |
| VAULT-02 | `recent-vaults.json` written/read correctly | Cargo test (JSON round-trip) + Vitest (store) | `cargo test recent_vaults` | Wave 0 gap |
| VAULT-03 | Last vault auto-loaded on startup | Manual E2E (launch app after vault opened previously) | Manual only | N/A |
| VAULT-04 | Welcome screen shown when no vault open | Vitest component test | `pnpm vitest run tests/WelcomeScreen.test.ts` | Wave 0 gap |
| VAULT-05 | Unreachable vault → Welcome + toast (no crash) | Manual + Vitest unit (store fallback logic) | `cargo test vault_unavailable` | Wave 0 gap |
| VAULT-06 | `get_vault_stats` returns file count | Cargo test with temp dir | `cargo test get_vault_stats` | Wave 0 gap |
| IDX-02 | Progress events emitted with correct payload | Vitest (mock listen + event assertion) + manual visual | `pnpm vitest run tests/indexProgress.test.ts` | Wave 0 gap |
| EDIT-01 | Markdown syntax highlighting renders | Manual visual (open `.md` with headings, code, lists) | Manual only | N/A |
| EDIT-02 | H1/H2/H3 visually larger; bold/italic styled | Manual visual | Manual only | N/A |
| EDIT-04 | Cmd+B/I/K wrap selection correctly | Vitest unit for `wrapSelection` helper | `pnpm vitest run tests/keymap.test.ts` | Wave 0 gap |
| EDIT-09 | Auto-save fires ~2s after last keystroke | Vitest with fake timers + manual wall-clock check | `pnpm vitest run tests/autoSave.test.ts` | Wave 0 gap |
| UI-04 | Toast renders error/clean-merge/conflict variants | Vitest component test for Toast.svelte | `pnpm vitest run tests/Toast.test.ts` | Wave 0 gap |
| ERR-01 | VaultError serializes to `{kind, message, data}` | Cargo test per variant | `cargo test vault_error_serialize` | Wave 0 gap |

### Sampling Rate

- **Per task commit:** `pnpm vitest run` (frontend unit tests only, < 30s)
- **Per wave merge:** `pnpm vitest run && cargo test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

All test files must be created before implementation:

- [ ] `vitest.config.ts` — Vitest configuration
- [ ] `src/test/setup.ts` — test setup (jest-dom matchers)
- [ ] `tests/vault.test.ts` — VAULT-01, VAULT-02 store/IPC tests
- [ ] `tests/WelcomeScreen.test.ts` — VAULT-04 component test
- [ ] `tests/indexProgress.test.ts` — IDX-02 event mock test
- [ ] `tests/keymap.test.ts` — EDIT-04 `wrapSelection` unit tests
- [ ] `tests/autoSave.test.ts` — EDIT-09 debounce with fake timers
- [ ] `tests/Toast.test.ts` — UI-04 Toast component variants
- [ ] `src-tauri/src/tests/error_serialize.rs` — ERR-01 serde round-trip
- [ ] `src-tauri/src/tests/vault_stats.rs` — VAULT-06 walkdir counter
- [ ] Framework install: `pnpm add -D vitest @testing-library/svelte @sveltejs/vite-plugin-svelte jsdom`

---

## 8. Risks and Unknowns

### Risk 1: Tauri v2 Plugin Capability Scope for User-Picked Directories

**What:** The `fs:scope` in `capabilities/default.json` is static. User-selected vault directories change at runtime. The documented solution is `FsExt::allow_directory` in Rust, but this is a Rust-side call that must happen inside the `open_vault` command.

**Implication for plan:** The `open_vault` command MUST call `app.fs_scope().allow_directory(&vault_path, true)` before any filesystem operations on that path. If this is missed, `read_file` and `write_file` will receive "path not allowed" errors at runtime.

**Risk level:** MEDIUM — `FsExt` is documented but the Rust API signature may differ between `tauri-plugin-fs` minor versions. Verify `Cargo.lock` pins the version after initial scaffold. [MEDIUM confidence]

### Risk 2: `thiserror` v2 vs v1 Breaking Changes

**What:** `thiserror` 2.0 was released in 2024. D-19 specifies `thiserror` without version. If the scaffold generates an older Cargo.lock, `thiserror = "2"` in Cargo.toml will pull v2, which has some syntax changes (e.g., `#[error(transparent)]` behavior changed for `#[from]` fields).

**Mitigation:** Use `thiserror = "2"` explicitly; the `#[from] std::io::Error` pattern in the `Io` variant works the same in v2. If compilation fails, fall back to `thiserror = "1"`.

### Risk 3: Svelte 5 + CM6 `$state` Proxy Issue

**What:** If a developer wraps `EditorView` in `$state` (understandable mistake), CM6 will fail silently or panic because Svelte's Proxy intercepts internal property access on the CM6 instance.

**Mitigation:** Document clearly in the CMEditor component: `let view: EditorView; // NOT $state`. Include a code comment explaining why. Add a runtime assertion in development mode: `if (view && view !== view) throw new Error(...)` (Proxy identity check). [ASSUMED: this is the right pattern; no official Svelte+CM6 documentation confirms it explicitly]

### Risk 4: Auto-Save Interpretation (Fixed 2s vs Idle 2s)

**What:** Spec §6.4 says "alle 2 Sekunden." This could mean:
- (a) Fixed repeating timer: save every 2s regardless of activity
- (b) Idle debounce: save 2s after last keystroke

**Chosen interpretation:** (b) Idle debounce — matches success criterion "User edits the file, waits ~2 seconds, and sees the change" and is what Obsidian-style apps do. Fixed-interval saves require dirty-state tracking to avoid unnecessary writes (spec says "kein Dirty-State-Indikator").

**Risk:** If user feedback is "saves happen too infrequently during rapid editing," can switch to a hybrid (debounce with max 5s ceiling). Phase 1 uses pure 2s debounce.

### Risk 5: `appDataDir()` Does Not Exist on First Run (Linux)

**What:** On Linux, `$XDG_DATA_HOME/vaultcore` (the appDataDir) may not exist before the first write. Tauri creates platform app dirs for some operations but not always for custom files.

**Mitigation:** Before writing `recent-vaults.json`, call `mkdir` with `{ recursive: true }` on the parent directory. The `plugin-fs` `mkdir` is idempotent (no error if already exists). This is already shown in the code pattern in §4.4.

### Risk 6: CM6 `basicSetup` Includes `closeBrackets` Which May Annoy Markdown Writers

**What:** `closeBrackets()` auto-inserts closing `]` when typing `[` — which conflicts with wiki-link typing (`[[Note]]`) if Phase 4 builds on this. It also auto-closes `*` in some configurations.

**Mitigation for Phase 1:** Leave `basicSetup` as-is; `closeBrackets` in CM6 is context-aware and doesn't activate inside strings. If it causes issues, replace `basicSetup` with the individual extensions listed in §6.3, omitting `closeBrackets()`. Flag for Phase 4 review when `[[` autocompletion is built.

### Risk 7: Tailwind CSS v4 vs v3 Config Differences

**What:** Tailwind 4.2.2 is current [VERIFIED: npm registry]. Tailwind 4 uses a CSS-first config (import `tailwindcss` in CSS, no `tailwind.config.js`). The Vite plugin is `@tailwindcss/vite`, not the old PostCSS plugin. Many tutorials still show v3 patterns.

**Mitigation:** Use `@tailwindcss/vite` as shown in §1.3. Do NOT follow tutorials using `postcss.config.js` with `require('tailwindcss')` — that's v3.

---

## CONTEXT Reconsiderations

### RC-01: Svelte Stores (D-06) vs. Class-Based `$state` Stores

**Finding:** Svelte 5 documentation recommends class-based `$state` objects in `.svelte.ts` files for shared state, noting they are "more performant than POJOs" due to JS engine optimizations. Classic `writable` stores are "not deprecated" but the ecosystem trend is toward rune-based stores.

**Impact assessment:** Low. Classic stores work correctly in Svelte 5. The ergonomic difference for Phase 1 is minimal. The interop issue — `get(store)` vs. `$derived` vs. `$store` — is well-understood.

**Recommendation:** D-06 holds. Classic `writable` stores are fine for Phase 1. If Phase 2 or Phase 5 finds the store pattern causing pain (e.g., coordination between HMR and async IPC), revisit. No CONTEXT change needed now.

### RC-02: D-13 `basicSetup` — Line Numbers for a Note App

**Finding:** `basicSetup` includes `lineNumbers()`. Line numbers are code-editor convention; most Markdown note apps (Obsidian, Typora) do NOT show line numbers by default.

**Impact assessment:** Aesthetic only. Does not affect any requirement.

**Recommendation:** Replace `basicSetup` with an explicit extension list (§6.3 shows the full list) and omit `lineNumbers()` and `foldGutter()`. This gives VaultCore a cleaner look from day 1 and avoids a Phase 5 Polish task to hide line numbers. Surface to user for confirmation before implementation. The planner should flag this as a decision point in Wave 0.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Tauri | 2.x (latest) | App framework, IPC, native APIs | Locked by spec |
| Svelte | 5.55.3 [VERIFIED] | Frontend UI | D-01 |
| Vite | 8.0.8 [VERIFIED] | Build tool | Ships with svelte-ts template |
| TypeScript | ~5.x (bundled) | Type safety | D-09 |
| @tauri-apps/api | 2.10.1 [VERIFIED] | Core IPC, path APIs | Official Tauri JS API |
| @tauri-apps/plugin-dialog | 2.7.0 [VERIFIED] | Native folder picker | D-20 |
| @tauri-apps/plugin-fs | 2.5.0 [VERIFIED] | File read/write/exists | D-20 |
| codemirror (basicSetup) | 6.x | Editor extensions bundle | D-13 |
| @codemirror/view | 6.41.0 [VERIFIED] | EditorView, keymap | CM6 core |
| @codemirror/state | 6.6.0 [VERIFIED] | EditorState, transactions | CM6 core |
| @codemirror/lang-markdown | 6.5.0 [VERIFIED] | Markdown + GFM | D-10 |
| @codemirror/language | 6.12.3 [VERIFIED] | HighlightStyle, syntaxHighlighting | D-10 |
| @lezer/highlight | 1.2.3 [VERIFIED] | `tags` for highlight rules | D-10 |
| tailwindcss | 4.2.2 [VERIFIED] | Styling | Locked by spec |
| @tailwindcss/vite | 4.x | Tailwind v4 Vite integration | Tailwind v4 requirement |

### Backend (Rust)

| Crate | Version | Purpose |
|-------|---------|---------|
| tauri | 2 | App framework |
| tauri-plugin-dialog | 2 | Native dialog |
| tauri-plugin-fs | 2 | FS operations with scoping |
| serde | 1 | Serialization |
| serde_json | 1 | JSON |
| thiserror | 2 | Error derive |
| sha2 | 0.10 | SHA-256 hashing |
| walkdir | 2 | Directory traversal |
| tokio | 1 (full) | Async runtime |
| log | 0.4 | Logging facade |
| env_logger | 0.11 | Log output |

### Dev Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| vitest | 4.1.4 [VERIFIED] | Unit + component testing |
| @testing-library/svelte | 5.3.1 [VERIFIED] | Svelte component testing |
| jsdom | latest | DOM environment for tests |

---

## References

### Primary (HIGH confidence)

1. [Tauri v2 — Create a Project](https://v2.tauri.app/start/create-project/) — scaffold command, project structure
2. [Tauri v2 — Plugin: Dialog](https://v2.tauri.app/plugin/dialog/) — `open({ directory: true })`, capabilities
3. [Tauri v2 — Plugin: File System](https://v2.tauri.app/plugin/file-system/) — permissions, `readTextFile`, `writeTextFile`, `exists`
4. [Tauri v2 — Calling Rust from Frontend](https://v2.tauri.app/develop/calling-rust/) — `#[tauri::command]`, error serialization pattern
5. [Tauri v2 — Calling Frontend from Rust](https://v2.tauri.app/develop/calling-frontend/) — `AppHandle::emit`, `listen()`
6. [Tauri v2 — Using Plugin Permissions](https://v2.tauri.app/learn/security/using-plugin-permissions/) — capabilities JSON format
7. [Tauri v2 — Path Namespace](https://v2.tauri.app/reference/javascript/api/namespacepath/) — `appDataDir()` import path
8. [Tauri v2 — Command Scopes](https://v2.tauri.app/security/scope/) — `fs:scope`, runtime scope expansion
9. [CodeMirror — System Guide](https://codemirror.net/docs/guide/) — EditorView lifecycle, transactions
10. [CodeMirror — Styling Example](https://codemirror.net/examples/styling/) — `HighlightStyle.define`, `EditorView.theme`
11. [CodeMirror — basicSetup source](https://github.com/codemirror/basic-setup/blob/main/src/codemirror.ts) — complete extension list
12. [Svelte 5 — What are Runes?](https://svelte.dev/docs/svelte/what-are-runes) — `$state`, `$derived`, `$effect`
13. [Svelte 5 — Stores](https://svelte.dev/docs/svelte/stores) — `writable` compatibility in Svelte 5
14. [Svelte 5 — Lifecycle Hooks](https://svelte.dev/docs/svelte/lifecycle-hooks) — `onMount`, `onDestroy`, `$effect`
15. [Svelte 5 — Testing](https://svelte.dev/docs/svelte/testing) — Vitest + jsdom setup
16. [walkdir crate docs](https://docs.rs/walkdir/latest/walkdir/) — streaming iterator, `filter_entry`, `follow_links`
17. [sha2 crate docs](https://docs.rs/sha2) — `Sha256::digest`, `Sha256::new() + update + finalize`

### Secondary (MEDIUM confidence)

18. [CM6 forum — Keymap for bold text in lang-markdown](https://discuss.codemirror.net/t/keymap-for-bold-text-in-lang-markdown/3150) — `changeByRange` toggle pattern for Mod-B
19. [CM6 forum — How to debounce in an updateListener](https://discuss.codemirror.net/t/how-to-debounce-in-an-updatelistener/8649) — debounce pattern for auto-save
20. [Mainmatter — Global state in Svelte 5](https://mainmatter.com/blog/2025/03/11/global-state-in-svelte-5/) — class vs writable tradeoffs
21. [npm registry — all package version checks](https://registry.npmjs.org) — VERIFIED current versions 2026-04-11

### Tertiary (LOW confidence — flag for validation)

22. [FsExt::allow_directory pattern](https://github.com/tauri-apps/tauri/discussions/7122) — runtime scope expansion; API may differ in latest plugin-fs version

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Auto-save is 2s idle debounce, not fixed 2s interval | §3.5, Risk 4 | Plan implements wrong behavior; easy to fix but changes test strategy |
| A2 | Tauri creates appDataDir automatically on first run; no manual mkdir needed | §4.4 | `writeTextFile` fails on Linux first run; fix = add `mkdir({ recursive: true })` before write |
| A3 | `simdutf8` unnecessary for Phase 1 UTF-8 validation | §4.2 | Negligible perf impact; std is fast enough |
| A4 | `FsExt::allow_directory` signature is `(path, recursive: bool)` | §1.5, Risk 1 | `open_vault` scope expansion fails; needs Rust doc verification during implementation |
| A5 | HMR reloads do not restart Rust backend | §5.3 | If wrong, vault store loses sync with Rust state; mitigated by store re-sync on mount |
| A6 | `thiserror` v2 `#[from] std::io::Error` pattern unchanged from v1 | §1.4 | Cargo build fails; fix = downgrade to `thiserror = "1"` |
| A7 | Skipping all dot-prefixed dirs (not just `.obsidian`) is correct | §4.1 | If user has important dot-dir vaults, files are silently excluded |

---

## Environment Availability

Phase 1 depends on build tooling. No Tauri-specific tooling is pre-installed in the project directory.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust toolchain | Tauri backend | [ASSUMED: available on dev machine] | Unknown — run `rustc --version` | Install via rustup.rs |
| pnpm | Scaffold + JS deps | [ASSUMED: available] | Unknown — run `pnpm --version` | `npm install -g pnpm` |
| Node.js >= 18 | Vite, pnpm | [ASSUMED: available] | Unknown — run `node --version` | Install via nvm |
| Tauri CLI | `tauri dev` / build | Installed via pnpm as `@tauri-apps/cli` | 2.10.1 (npm) | `pnpm add -D @tauri-apps/cli` |

**Wave 0 action:** Add `cargo --version`, `rustc --version`, `pnpm --version`, `node --version` as first verification step in the plan.

---

*Research date: 2026-04-11*
*Valid until: 2026-05-11 (Tauri v2 plugin APIs evolve; re-verify FsExt if > 30 days)*
