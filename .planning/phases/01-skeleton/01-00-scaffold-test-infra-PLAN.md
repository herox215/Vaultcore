---
phase: 01-skeleton
plan: 00
type: execute
wave: 0
depends_on: []
files_modified:
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - tsconfig.json
  - vite.config.ts
  - vitest.config.ts
  - index.html
  - src/main.ts
  - src/App.svelte
  - src/styles/tailwind.css
  - src/test/setup.ts
  - src/components/Welcome/.gitkeep
  - src/components/Editor/.gitkeep
  - src/components/Toast/.gitkeep
  - src/components/Progress/.gitkeep
  - src/store/.gitkeep
  - src/ipc/.gitkeep
  - src/types/.gitkeep
  - tests/vault.test.ts
  - tests/WelcomeScreen.test.ts
  - tests/indexProgress.test.ts
  - tests/keymap.test.ts
  - tests/autoSave.test.ts
  - tests/Toast.test.ts
  - src-tauri/Cargo.toml
  - src-tauri/tauri.conf.json
  - src-tauri/capabilities/default.json
  - src-tauri/src/main.rs
  - src-tauri/src/lib.rs
autonomous: false
requirements:
  - VAULT-01
  - VAULT-02
  - VAULT-03
  - VAULT-04
  - VAULT-05
  - VAULT-06
  - IDX-02
  - EDIT-01
  - EDIT-02
  - EDIT-04
  - EDIT-09
  - UI-04
  - ERR-01
must_haves:
  truths:
    - "`pnpm vitest run` exits 0 with every Wave 0 test file discovered (skipped or todo is fine)"
    - "`cargo build --manifest-path src-tauri/Cargo.toml` compiles successfully"
    - "`tsc --noEmit` passes with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` enabled"
    - "Every D-18 directory exists; no demo code remains"
    - "RC-02 CodeMirror extension decision is recorded in a single committed source-of-truth comment"
  artifacts:
    - path: "package.json"
      provides: "Frontend build + test scripts"
      contains: "vitest"
    - path: "src-tauri/Cargo.toml"
      provides: "Phase 1 crate dep set per D-19"
      contains: "tauri-plugin-dialog"
    - path: "vitest.config.ts"
      provides: "Vitest jsdom + svelte plugin config"
      contains: "jsdom"
    - path: "src/test/setup.ts"
      provides: "jest-dom matchers + fake timers helper"
    - path: "tests/vault.test.ts"
      provides: "VAULT-01/02/05 test skeleton"
    - path: "tests/WelcomeScreen.test.ts"
      provides: "VAULT-04 component test skeleton"
    - path: "tests/indexProgress.test.ts"
      provides: "IDX-02 event mock skeleton"
    - path: "tests/keymap.test.ts"
      provides: "EDIT-04 wrapSelection skeleton"
    - path: "tests/autoSave.test.ts"
      provides: "EDIT-09 debounce skeleton"
    - path: "tests/Toast.test.ts"
      provides: "UI-04 variant skeleton"
    - path: "src-tauri/capabilities/default.json"
      provides: "Tauri v2 capability set (dialog + fs + appdata scope)"
      contains: "fs:scope"
    - path: "tsconfig.json"
      provides: "Strict TS config per D-09"
      contains: "exactOptionalPropertyTypes"
    - path: "src/styles/tailwind.css"
      provides: "Tailwind v4 entry + CSS variables per UI-SPEC"
      contains: "--color-accent"
  key_links:
    - from: "vite.config.ts"
      to: "@tailwindcss/vite"
      via: "plugin array"
      pattern: "tailwindcss\\(\\)"
    - from: "vitest.config.ts"
      to: "@sveltejs/vite-plugin-svelte"
      via: "plugin array"
      pattern: "svelte\\("
    - from: "src/main.ts"
      to: "src/styles/tailwind.css"
      via: "import"
      pattern: "import.*tailwind.css"
---

<objective>
Scaffold the entire VaultCore greenfield project (Tauri 2 + Svelte 5 + Vite + Tailwind v4 + Vitest) and lay down ALL Wave 0 test skeletons before any implementation begins. This plan creates `package.json`, `Cargo.toml`, the D-18 directory tree, the strict TS config, the Vitest configuration, the jsdom setup, every REQ-ID test stub (as `it.todo` placeholders), the UI-SPEC Tailwind CSS variables, and records the RC-02 decision (explicit CM6 extension list, no line numbers — locked here).

Purpose: Every later wave depends on compilable frontend + backend plus red-or-todo tests mapped to every REQ-ID. No implementation task may run before this plan ships.

Output: Working `pnpm vitest run` + `cargo build` in an otherwise empty but well-structured Tauri 2 + Svelte 5 project.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/01-skeleton/01-CONTEXT.md
@.planning/phases/01-skeleton/01-RESEARCH.md
@.planning/phases/01-skeleton/01-UI-SPEC.md
@.planning/phases/01-skeleton/01-VALIDATION.md
@CLAUDE.md
@VaultCore_MVP_Spezifikation_v3.md

<interfaces>
<!-- No existing code — this plan creates the first interfaces. Every downstream plan reads back from here. -->

RC-02 decision locked in this plan (recorded in src/components/Editor/extensions.ts header comment):
  Use EXPLICIT CM6 extension list, NOT `basicSetup`.
  Omit `lineNumbers()` and `foldGutter()` (note-app aesthetic per UI-SPEC).
  Keep: history, drawSelection, dropCursor, indentOnInput, bracketMatching, closeBrackets,
        highlightActiveLine, EditorView.lineWrapping, keymap(defaultKeymap + historyKeymap).

Directory skeleton this plan creates (D-18):
  src/components/{Welcome,Editor,Toast,Progress}/   (with .gitkeep)
  src/store/                                         (with .gitkeep)
  src/ipc/                                           (with .gitkeep)
  src/types/                                         (with .gitkeep)
  src/styles/tailwind.css                            (Tailwind v4 + CSS vars)
  src/test/setup.ts
  tests/                                             (Vitest test skeletons)
  src-tauri/src/                                     (Cargo workspace)
  src-tauri/capabilities/default.json
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Scaffold Tauri 2 + Svelte 5 project and install Phase 1 dep set</name>
  <files>
    package.json, pnpm-lock.yaml, vite.config.ts, tsconfig.json, index.html,
    src/main.ts, src/App.svelte, src/styles/tailwind.css,
    src-tauri/Cargo.toml, src-tauri/tauri.conf.json, src-tauri/src/main.rs,
    src-tauri/src/lib.rs, src-tauri/capabilities/default.json,
    src/components/Welcome/.gitkeep, src/components/Editor/.gitkeep,
    src/components/Toast/.gitkeep, src/components/Progress/.gitkeep,
    src/store/.gitkeep, src/ipc/.gitkeep, src/types/.gitkeep
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-CONTEXT.md (D-01..D-20, D-23 — scaffold + dep constraints)
    - .planning/phases/01-skeleton/01-RESEARCH.md §1 Tauri 2 Scaffolding, §1.3 Tailwind v4, §1.4 Rust Plugin Registration, §1.5 Capabilities, §1.6 tsconfig
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Design System", "Color" (CSS variables), "Typography"
    - CLAUDE.md (performance budgets, zero-network guarantee)
  </read_first>
  <action>
    Scaffold via `pnpm create tauri-app --name vaultcore --template svelte-ts --manager pnpm` in the current empty project directory (use `.` as the name if needed).

    After scaffold:
    1. **Strip demo code:** Delete `src/lib/Greet.svelte` (and any `src/lib/` or `src/assets/` demo files). Replace `src/App.svelte` body with a minimal empty shell: `<script lang="ts"></script><main class="vc-app"></main>`. Do NOT leave any imported demo components.

    2. **Create D-18 directory skeleton** with `.gitkeep` files so each dir is tracked:
       - `src/components/Welcome/.gitkeep`
       - `src/components/Editor/.gitkeep`
       - `src/components/Toast/.gitkeep`
       - `src/components/Progress/.gitkeep`
       - `src/store/.gitkeep`
       - `src/ipc/.gitkeep`
       - `src/types/.gitkeep`

    3. **Install frontend runtime deps (D-19/D-20):**
       ```
       pnpm add @tauri-apps/api@^2 @tauri-apps/plugin-dialog@^2 @tauri-apps/plugin-fs@^2 \
                codemirror@^6 @codemirror/view@^6 @codemirror/state@^6 \
                @codemirror/lang-markdown@^6 @codemirror/language@^6 \
                @codemirror/commands@^6 @lezer/highlight@^1
       ```

    4. **Install Tailwind v4 (RESEARCH §1.3):**
       ```
       pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4
       ```
       In `vite.config.ts` add `tailwindcss()` from `@tailwindcss/vite` to the `plugins` array alongside `svelte()`. Do NOT add `postcss.config.js` or a legacy `tailwind.config.js` — Tailwind v4 is CSS-first.

    5. **Replace `src/styles/tailwind.css`** with:
       ```css
       @import "tailwindcss";

       :root {
         --color-bg:        #F5F5F4;
         --color-surface:   #FFFFFF;
         --color-border:    #E5E5E4;
         --color-text:      #1C1C1A;
         --color-text-muted:#6B7280;
         --color-accent:    #6D28D9;
         --color-accent-bg: #EDE9FE;
         --color-error:     #DC2626;
         --color-warning:   #D97706;
         --color-success:   #059669;

         --vc-font-body: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         --vc-font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
       }

       html, body, #app { height: 100%; margin: 0; background: var(--color-bg); color: var(--color-text); font-family: var(--vc-font-body); font-size: 14px; line-height: 1.5; }
       ```
       Update `src/main.ts` to `import './styles/tailwind.css'` (remove any other `.css` imports left over from the template). Update `index.html` to reference `src/main.ts` only.

    6. **Overwrite `tsconfig.json`** with D-09 strict settings (keep the scaffold's `include` array):
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
           "resolveJsonModule": true,
           "allowSyntheticDefaultImports": true,
           "isolatedModules": true,
           "esModuleInterop": true,
           "skipLibCheck": true,
           "types": ["svelte", "vite/client"]
         },
         "include": ["src/**/*.ts", "src/**/*.svelte", "tests/**/*.ts"]
       }
       ```

    7. **Rewrite `src-tauri/Cargo.toml` `[dependencies]`** to the exact D-19 set:
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
       Do NOT add `tantivy`, `notify`, `pulldown-cmark`, `regex`, `rayon`, `similar`, `fuzzy-matcher`, or `chrono`.

    8. **Rewrite `src-tauri/capabilities/default.json`** (RESEARCH §1.5):
       ```json
       {
         "$schema": "../gen/schemas/desktop-schema.json",
         "identifier": "main-capability",
         "description": "VaultCore Phase 1 capabilities",
         "windows": ["main"],
         "permissions": [
           "core:default",
           "dialog:default",
           "dialog:allow-open",
           "fs:default",
           "fs:allow-read-text-file",
           "fs:allow-write-text-file",
           "fs:allow-exists",
           "fs:allow-mkdir",
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

    9. **`src-tauri/src/lib.rs`** — set up builder with plugins (empty `invoke_handler` for now; Wave 1 fills it):
       ```rust
       pub fn run() {
           env_logger::init();
           tauri::Builder::default()
               .plugin(tauri_plugin_dialog::init())
               .plugin(tauri_plugin_fs::init())
               .run(tauri::generate_context!())
               .expect("error running tauri application");
       }
       ```
       `src-tauri/src/main.rs` stays the scaffold default that calls `lib::run()`.

    10. **Add `pnpm` scripts in `package.json`:**
        ```json
        "scripts": {
          "dev": "vite",
          "build": "vite build && tsc --noEmit",
          "typecheck": "tsc --noEmit",
          "test": "vitest run",
          "test:watch": "vitest",
          "tauri": "tauri"
        }
        ```

    Run `pnpm install`, then `cargo build --manifest-path src-tauri/Cargo.toml` to verify both halves compile.
  </action>
  <verify>
    <automated>test -f package.json &amp;&amp; test -f src-tauri/Cargo.toml &amp;&amp; test -f vite.config.ts &amp;&amp; test -f tsconfig.json &amp;&amp; test -f src/styles/tailwind.css &amp;&amp; test -f src-tauri/capabilities/default.json &amp;&amp; pnpm typecheck &amp;&amp; cargo build --manifest-path src-tauri/Cargo.toml</automated>
  </verify>
  <acceptance_criteria>
    - `package.json` contains `"vitest"` AND `"@tauri-apps/plugin-dialog"` AND `"@tauri-apps/plugin-fs"` AND `"codemirror"` AND `"@codemirror/lang-markdown"` AND `"@tailwindcss/vite"`
    - `src-tauri/Cargo.toml` contains all of: `tauri = { version = "2"`, `tauri-plugin-dialog = "2"`, `tauri-plugin-fs = "2"`, `thiserror = "2"`, `sha2 = "0.10"`, `walkdir = "2"`, `tokio`, `env_logger`
    - `src-tauri/Cargo.toml` does NOT contain any of: `tantivy`, `notify`, `pulldown-cmark`, `regex`, `rayon`, `similar`, `fuzzy-matcher`, `chrono`
    - `tsconfig.json` contains `"strict": true` AND `"noUncheckedIndexedAccess": true` AND `"exactOptionalPropertyTypes": true`
    - `vite.config.ts` contains `tailwindcss()` AND `svelte(`
    - `src/styles/tailwind.css` contains `@import "tailwindcss"` AND all ten CSS variables (`--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-accent-bg`, `--color-error`, `--color-warning`, `--color-success`)
    - `src-tauri/capabilities/default.json` contains `"dialog:default"` AND `"fs:default"` AND `"fs:scope"`
    - `src-tauri/src/lib.rs` contains `tauri_plugin_dialog::init()` AND `tauri_plugin_fs::init()`
    - `src/App.svelte` does NOT contain `Greet` or `Counter` or the word `welcome` from the scaffold demo (case-insensitive, excluding the eventual `Welcome/` folder references added later)
    - Directories exist: `src/components/Welcome/`, `src/components/Editor/`, `src/components/Toast/`, `src/components/Progress/`, `src/store/`, `src/ipc/`, `src/types/`, `src-tauri/src/`
    - `pnpm typecheck` exits 0
    - `cargo build --manifest-path src-tauri/Cargo.toml` exits 0
  </acceptance_criteria>
  <done>Empty project compiles (frontend + backend), strict TS passes, all Phase 1 deps installed, directory skeleton in place, no demo code remains.</done>
</task>

<task type="auto">
  <name>Task 2: Install Vitest + configure jsdom + create every Wave 0 test skeleton</name>
  <files>
    package.json, vitest.config.ts, src/test/setup.ts,
    tests/vault.test.ts, tests/WelcomeScreen.test.ts, tests/indexProgress.test.ts,
    tests/keymap.test.ts, tests/autoSave.test.ts, tests/Toast.test.ts,
    src/components/Editor/extensions.ts
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-VALIDATION.md "Wave 0 Requirements" + "Per-Task Verification Map"
    - .planning/phases/01-skeleton/01-RESEARCH.md §7 Validation Architecture, §8 Risk 3 (RC-01), RC-02
    - .planning/phases/01-skeleton/01-CONTEXT.md D-10/D-13 (CM6 extensions), D-17 (InvalidEncoding toast trigger)
    - package.json (from Task 1)
  </read_first>
  <action>
    1. **Install Vitest stack** (exact versions from RESEARCH §7):
       ```
       pnpm add -D vitest@^4 @testing-library/svelte@^5 @sveltejs/vite-plugin-svelte jsdom @testing-library/jest-dom
       ```

    2. **Create `vitest.config.ts`:**
       ```typescript
       import { defineConfig } from 'vitest/config';
       import { svelte } from '@sveltejs/vite-plugin-svelte';

       export default defineConfig({
         plugins: [svelte({ hot: !process.env.VITEST })],
         test: {
           environment: 'jsdom',
           globals: true,
           setupFiles: ['src/test/setup.ts'],
           include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
         },
         resolve: process.env.VITEST
           ? { conditions: ['browser'] }
           : undefined,
       });
       ```

    3. **Create `src/test/setup.ts`:**
       ```typescript
       import '@testing-library/jest-dom/vitest';
       import { vi } from 'vitest';

       // Fake timers helper used by autoSave.test.ts — opt-in per test
       export function withFakeTimers() {
         vi.useFakeTimers();
         return () => vi.useRealTimers();
       }
       ```

    4. **Create every VALIDATION.md Wave 0 test skeleton** — each file must exist with `it.todo` placeholders covering every REQ-ID row in the Per-Task Verification Map. Each test must reference its REQ-ID in its name so the validation map can grep for coverage.

       **`tests/vault.test.ts`** (VAULT-01, VAULT-02, VAULT-04 eviction, VAULT-05):
       ```typescript
       import { describe, it } from 'vitest';

       describe('VAULT-01: open vault via folder picker', () => {
         it.todo('VAULT-01: invokes native dialog open({ directory: true }) and returns picked path');
       });

       describe('VAULT-02: recent-vaults.json persistence', () => {
         it.todo('VAULT-02: round-trips { vaults: [...] } through appDataDir/recent-vaults.json');
         it.todo('VAULT-02: reads empty array when file does not exist');
       });

       describe('VAULT-04: recent vault list eviction (FIFO at 10)', () => {
         it.todo('VAULT-04: caps at 10 entries and evicts the oldest when a new vault is added');
         it.todo('VAULT-04: deduplicates by path (moves existing entry to the front instead of adding a duplicate)');
       });

       describe('VAULT-05: unreachable vault fallback', () => {
         it.todo('VAULT-05: when recent-vaults.json points at a missing path, vaultStore resets to idle and emits an error message');
       });
       ```

       **`tests/WelcomeScreen.test.ts`** (VAULT-04 render):
       ```typescript
       import { describe, it } from 'vitest';

       describe('VAULT-04: Welcome screen renders', () => {
         it.todo('VAULT-04: renders "VaultCore" heading and "Open vault" button when vault store is idle');
         it.todo('VAULT-04: renders "No recent vaults" empty state when recent list is empty');
         it.todo('VAULT-04: renders recent vault rows when recent list has entries');
       });
       ```

       **`tests/indexProgress.test.ts`** (IDX-02):
       ```typescript
       import { describe, it } from 'vitest';

       describe('IDX-02: vault://index_progress events', () => {
         it.todo('IDX-02: listen() callback receives { current, total, current_file } payloads from a mocked emit');
         it.todo('IDX-02: progress store transitions from 0/N to N/N and hides the progress UI when current === total');
       });
       ```

       **`tests/keymap.test.ts`** (EDIT-04):
       ```typescript
       import { describe, it } from 'vitest';

       describe('EDIT-04: wrapSelection keymap commands', () => {
         it.todo('EDIT-04: Mod-b wraps current selection with ** on both sides');
         it.todo('EDIT-04: Mod-b on already-wrapped selection removes the ** wrapping (toggle)');
         it.todo('EDIT-04: Mod-i wraps current selection with * on both sides');
         it.todo('EDIT-04: Mod-k replaces selection with [selection](url) and places cursor inside ()');
         it.todo('EDIT-04: Mod-k on empty selection inserts [link text](url)');
       });
       ```

       **`tests/autoSave.test.ts`** (EDIT-09):
       ```typescript
       import { describe, it } from 'vitest';

       describe('EDIT-09: auto-save 2s idle debounce', () => {
         it.todo('EDIT-09: a single keystroke schedules onSave exactly once after 2000 ms');
         it.todo('EDIT-09: successive keystrokes within 2000 ms reset the debounce (only one save fires)');
         it.todo('EDIT-09: docChanged === false does not schedule a save');
       });
       ```

       **`tests/Toast.test.ts`** (UI-04):
       ```typescript
       import { describe, it } from 'vitest';

       describe('UI-04: Toast variants', () => {
         it.todo('UI-04: renders error variant with --color-error left border and ✕ icon');
         it.todo('UI-04: renders conflict variant with --color-warning left border and ⚠ icon');
         it.todo('UI-04: renders clean-merge variant with --color-success left border and ✓ icon');
         it.todo('UI-04: auto-dismisses after 5000 ms');
         it.todo('UI-04: dismiss button removes the toast from the DOM');
         it.todo('UI-04: stacking past 3 toasts drops the oldest');
       });
       ```

    5. **Create `src/components/Editor/extensions.ts`** with ONLY a header comment that locks the RC-02 decision — the actual extension array is built in Wave 3, but the decision lives here so every later reader sees it first:
       ```typescript
       // RC-02 DECISION (locked Phase 1 Wave 0):
       // VaultCore uses an EXPLICIT CodeMirror 6 extension list, NOT `basicSetup`.
       // Rationale: note apps (Obsidian, Typora) do not show line numbers by default;
       // `basicSetup` would force a Phase 5 Polish task to hide them.
       //
       // Phase 1 extension list (built in Wave 3 / plan 01-03):
       //   history()
       //   drawSelection()
       //   dropCursor()
       //   indentOnInput()
       //   bracketMatching()
       //   closeBrackets()
       //   highlightActiveLine()
       //   EditorView.lineWrapping
       //   keymap.of([...defaultKeymap, ...historyKeymap, ...vaultKeymap])
       //   markdown({ extensions: [GFM] })
       //   syntaxHighlighting(markdownHighlightStyle)
       //   markdownTheme
       //   autoSaveExtension(onSave)
       //
       // Explicitly NOT included: lineNumbers(), foldGutter().

       export const RC_02_LOCKED = true as const;
       ```

    Run `pnpm vitest run` to confirm all test files load (every test is `it.todo` so runtime is ~1 s and every test shows as "todo" in the reporter).
  </action>
  <verify>
    <automated>pnpm vitest run</automated>
  </verify>
  <acceptance_criteria>
    - `vitest.config.ts` contains `environment: 'jsdom'` AND `setupFiles:` AND `svelte(`
    - `src/test/setup.ts` contains `@testing-library/jest-dom/vitest`
    - All six test files exist: `tests/vault.test.ts`, `tests/WelcomeScreen.test.ts`, `tests/indexProgress.test.ts`, `tests/keymap.test.ts`, `tests/autoSave.test.ts`, `tests/Toast.test.ts`
    - `grep -c "it.todo" tests/vault.test.ts` returns at least 5
    - `grep -c "it.todo" tests/WelcomeScreen.test.ts` returns at least 3
    - `grep -c "it.todo" tests/indexProgress.test.ts` returns at least 2
    - `grep -c "it.todo" tests/keymap.test.ts` returns at least 5
    - `grep -c "it.todo" tests/autoSave.test.ts` returns at least 3
    - `grep -c "it.todo" tests/Toast.test.ts` returns at least 6
    - Every `it.todo` string starts with its REQ-ID (`VAULT-01`, `VAULT-02`, `VAULT-04`, `VAULT-05`, `IDX-02`, `EDIT-04`, `EDIT-09`, `UI-04`) — verify with `grep -E "it\.todo\('(VAULT|IDX|EDIT|UI)-"` on each file
    - `src/components/Editor/extensions.ts` contains `RC-02 DECISION` AND `EXPLICIT CodeMirror 6 extension list, NOT` AND `NOT included: lineNumbers`
    - `package.json` devDependencies contain `vitest` AND `@testing-library/svelte` AND `@sveltejs/vite-plugin-svelte` AND `jsdom` AND `@testing-library/jest-dom`
    - `pnpm vitest run` exits 0 (every test marked todo is acceptable)
  </acceptance_criteria>
  <done>Vitest runs, every REQ-ID in VALIDATION.md has at least one `it.todo` stub, RC-02 decision is recorded and grep-verifiable in a committed source file.</done>
</task>

<task type="auto">
  <name>Task 3: Rust test module skeletons for ERR-01, VAULT-02/04/06</name>
  <files>
    src-tauri/src/main.rs,
    src-tauri/src/lib.rs,
    src-tauri/src/error.rs,
    src-tauri/src/commands/mod.rs,
    src-tauri/src/commands/vault.rs,
    src-tauri/src/commands/files.rs,
    src-tauri/src/tests/mod.rs,
    src-tauri/src/tests/error_serialize.rs,
    src-tauri/src/tests/vault_stats.rs
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-VALIDATION.md (Wave 0 cargo test requirements)
    - .planning/phases/01-skeleton/01-RESEARCH.md §2.1 VaultError (full code sample), §4 Filesystem
    - .planning/phases/01-skeleton/01-CONTEXT.md D-18 (backend scaffold), D-19 (dep set)
    - VaultCore_MVP_Spezifikation_v3.md §5 (VaultError variants)
  </read_first>
  <action>
    Create the empty Rust module skeleton so Wave 1 has something to fill in, and create `#[cfg(test)]` stubs for every Wave 0 cargo test file. The actual enum variants and command bodies are implemented in plan 01-01 (Wave 1) — this task creates compiling placeholder modules so `cargo build` and `cargo test` both succeed.

    1. **Create `src-tauri/src/error.rs`** with an empty-but-compiling placeholder:
       ```rust
       // Wave 0 placeholder — full implementation lands in plan 01-01.
       // Kept minimal so cargo build succeeds without committing to the enum layout.

       #[derive(Debug, thiserror::Error)]
       pub enum VaultError {
           #[error("placeholder")]
           Placeholder,
       }

       impl serde::Serialize for VaultError {
           fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
           where
               S: serde::Serializer,
           {
               serializer.serialize_str("placeholder")
           }
       }
       ```

    2. **Create `src-tauri/src/commands/mod.rs`:**
       ```rust
       pub mod vault;
       pub mod files;
       ```

    3. **Create `src-tauri/src/commands/vault.rs`** (empty placeholder, Wave 1 adds commands):
       ```rust
       // Wave 0 placeholder — commands added in plan 01-01.
       // Intentionally empty so cargo build succeeds.
       ```

    4. **Create `src-tauri/src/commands/files.rs`** (same placeholder pattern).

    5. **Update `src-tauri/src/lib.rs`** to declare the module tree:
       ```rust
       pub mod error;
       pub mod commands;

       #[cfg(test)]
       mod tests;

       pub fn run() {
           env_logger::init();
           tauri::Builder::default()
               .plugin(tauri_plugin_dialog::init())
               .plugin(tauri_plugin_fs::init())
               .run(tauri::generate_context!())
               .expect("error running tauri application");
       }
       ```

    6. **Create `src-tauri/src/tests/mod.rs`:**
       ```rust
       mod error_serialize;
       mod vault_stats;
       ```

    7. **Create `src-tauri/src/tests/error_serialize.rs`** with `#[ignore]` stubs named for every ERR-01 variant so grep coverage works:
       ```rust
       // ERR-01 test stubs — filled in plan 01-01 (Wave 1).

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_file_not_found() {}

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_permission_denied() {}

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_disk_full() {}

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_index_corrupt() {}

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_vault_unavailable() {}

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_merge_conflict() {}

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_invalid_encoding() {}

       #[test]
       #[ignore = "ERR-01 stub — filled in plan 01-01"]
       fn vault_error_serialize_io() {}
       ```

    8. **Create `src-tauri/src/tests/vault_stats.rs`** with VAULT-02, VAULT-04, VAULT-06 stubs:
       ```rust
       // VAULT-02 / VAULT-04 / VAULT-06 test stubs — filled in plan 01-01 (Wave 1).

       #[test]
       #[ignore = "VAULT-06 stub — filled in plan 01-01"]
       fn get_vault_stats_counts_md_files() {}

       #[test]
       #[ignore = "VAULT-06 stub — filled in plan 01-01"]
       fn get_vault_stats_skips_dot_dirs() {}

       #[test]
       #[ignore = "VAULT-02 stub — filled in plan 01-01"]
       fn recent_vaults_round_trip() {}

       #[test]
       #[ignore = "VAULT-04 stub — filled in plan 01-01"]
       fn recent_vaults_eviction_caps_at_ten() {}

       #[test]
       #[ignore = "VAULT-04 stub — filled in plan 01-01"]
       fn recent_vaults_dedupe_moves_to_front() {}

       #[test]
       #[ignore = "VAULT-05 stub — filled in plan 01-01"]
       fn open_vault_returns_vault_unavailable_for_missing_path() {}
       ```

    Verify with `cargo build --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml` (all ignored tests pass trivially).
  </action>
  <verify>
    <automated>cd src-tauri &amp;&amp; cargo build &amp;&amp; cargo test -- --include-ignored --list 2&gt;&amp;1 | grep -c "ignored"</automated>
  </verify>
  <acceptance_criteria>
    - `src-tauri/src/error.rs` contains `pub enum VaultError` AND `impl serde::Serialize for VaultError`
    - `src-tauri/src/lib.rs` contains `pub mod error;` AND `pub mod commands;`
    - `src-tauri/src/commands/mod.rs` contains `pub mod vault;` AND `pub mod files;`
    - `src-tauri/src/tests/mod.rs` contains `mod error_serialize;` AND `mod vault_stats;`
    - `grep -c "fn vault_error_serialize_" src-tauri/src/tests/error_serialize.rs` returns exactly 8 (one per spec §5 variant)
    - `src-tauri/src/tests/vault_stats.rs` contains `fn get_vault_stats_counts_md_files`, `fn recent_vaults_round_trip`, `fn recent_vaults_eviction_caps_at_ten`, `fn recent_vaults_dedupe_moves_to_front`, `fn open_vault_returns_vault_unavailable_for_missing_path`
    - `cargo build --manifest-path src-tauri/Cargo.toml` exits 0
    - `cargo test --manifest-path src-tauri/Cargo.toml` exits 0 (ignored tests are listed but not executed)
    - `cargo test --manifest-path src-tauri/Cargo.toml -- --list 2>&1 | grep -c ": test$"` returns at least 14 (the total stub count)
  </acceptance_criteria>
  <done>Rust module tree compiles, every Wave 1 REQ-ID has a named `#[ignore]` test stub, cargo test green.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Human verification — Wave 0 gate</name>
  <files>(no file changes — verification checkpoint only)</files>
  <what-built>
    Tauri 2 + Svelte 5 + Vite + Tailwind v4 project scaffolded. All Phase 1 dependencies installed (`tauri-plugin-dialog`, `tauri-plugin-fs`, CodeMirror 6 core + lang-markdown, Vitest + @testing-library/svelte). Strict TS config active. Every VALIDATION.md REQ-ID has an `it.todo` (frontend) or `#[ignore]` (backend) test stub. RC-02 decision locked in `src/components/Editor/extensions.ts` header. Directory skeleton matches D-18 exactly.
  </what-built>
  <action>
    This is a checkpoint task — no file changes. Pause execution and run the human-verify steps below. If every step passes, type "approved" to resume and unlock Wave 1. If any step fails, describe the issue and return to the prior task for remediation.
  </action>
  <how-to-verify>
    1. Run `pnpm typecheck` — must exit 0
    2. Run `pnpm vitest run` — must exit 0, every test shows as "todo"
    3. Run `cargo build --manifest-path src-tauri/Cargo.toml` — must exit 0
    4. Run `cargo test --manifest-path src-tauri/Cargo.toml` — must exit 0 (ignored stubs counted)
    5. Run `pnpm tauri dev` — Tauri dev window should open to a blank white screen (empty `App.svelte`). Close the window.
    6. Open `src/styles/tailwind.css` — confirm all 10 CSS variables from UI-SPEC "Color" section are present
    7. Open `src/components/Editor/extensions.ts` — confirm RC-02 decision comment is present and locks the explicit extension list
    8. Confirm `src-tauri/Cargo.toml` does NOT contain `tantivy`, `notify`, `pulldown-cmark`, `regex`, `rayon`, `similar`, `fuzzy-matcher`, or `chrono`
  </how-to-verify>
  <verify>
    <automated>pnpm typecheck &amp;&amp; pnpm vitest run &amp;&amp; cargo build --manifest-path src-tauri/Cargo.toml &amp;&amp; cargo test --manifest-path src-tauri/Cargo.toml</automated>
  </verify>
  <done>Human has typed "approved" after completing all eight verification steps above.</done>
  <resume-signal>Type "approved" to unlock Wave 1, or describe issues for remediation</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| none (scaffold only) | No runtime data flow in Wave 0 — project compiles to an empty window |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-00-01 | Tampering | `src-tauri/capabilities/default.json` | mitigate | Scope fs:scope to `$APPDATA` and `$APPDATA/**` ONLY in Wave 0. User-picked vault paths are granted via runtime `FsExt::allow_directory` in Wave 1 (plan 01-01). If we shipped a blanket `$HOME` scope here, every later plan would inherit an over-broad capability surface. |
| T-01-00-02 | Information Disclosure | CodeMirror / Tailwind CDN URLs | mitigate | Task 1 uses `@tailwindcss/vite` (local compile) and installs CodeMirror via pnpm — no CDN script tags, no remote font imports, no `fetch()`. Font stack is the OS system-ui stack (no Google Fonts). Verified by grep: `grep -r "cdn\." src/ index.html` must return nothing. |
| T-01-00-06 | Repudiation (SEC-01 compliance) | Scaffold output | mitigate | The scaffold template may include analytics placeholders. Task 1 strips all demo code and Task 4 human verification confirms no `fetch()`, `http`, or analytics call is present. |
| T-01-00-T | Elevation of Privilege | `tsconfig.json` | mitigate | `strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes` catches the class of bugs where an index access returns `undefined` and is treated as a defined value — closes a path-traversal vector in later plans where `recentVaults[idx].path` could otherwise be `undefined`. |
| T-01-00-D | Denial of Service (build-time) | `Cargo.toml` dep set | accept | `cargo build` pulls Tauri + plugins. First build may take 2–5 min on a cold machine. Accepted — one-time cost. |
</threat_model>

<verification>
- `pnpm typecheck` exits 0
- `pnpm vitest run` exits 0 with all tests as `todo`
- `cargo build --manifest-path src-tauri/Cargo.toml` exits 0
- `cargo test --manifest-path src-tauri/Cargo.toml` exits 0
- `pnpm tauri dev` launches a blank window and closes cleanly
- No `fetch`, `http://`, `https://`, `cdn.`, `googleapis.com` appear in `src/` or `index.html` (grep check in human verify)
</verification>

<success_criteria>
1. Every Wave 0 artifact from VALIDATION.md exists and is grep-verifiable
2. Project compiles frontend + backend
3. Every REQ-ID in `requirements:` has at least one skeleton test file referencing it by ID
4. RC-02 decision is committed in `src/components/Editor/extensions.ts`
5. D-19 dep set exactly — no extra crates
6. UI-SPEC color CSS variables exist in `src/styles/tailwind.css`
7. Wave 0 human verification checkpoint approved
</success_criteria>

<output>
After completion, create `.planning/phases/01-skeleton/01-00-SUMMARY.md` per summary template.
</output>
