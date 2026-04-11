---
phase: 01-skeleton
plan: 04
type: execute
wave: 4
depends_on:
  - "01-skeleton/00"
  - "01-skeleton/01"
  - "01-skeleton/02"
  - "01-skeleton/03"
files_modified:
  - src-tauri/src/commands/vault.rs
  - src-tauri/src/tests/vault_stats.rs
  - src/components/Progress/ProgressBar.svelte
  - src/components/Welcome/VaultView.svelte
  - src/components/Welcome/FileListRow.svelte
  - src/ipc/events.ts
  - src/store/progressStore.ts
  - src/App.svelte
  - tests/indexProgress.test.ts
autonomous: false
requirements:
  - IDX-02
  - VAULT-06
  - EDIT-01
  - EDIT-02
must_haves:
  truths:
    - "`open_vault` performs a two-pass walk (count → emit progress events at ≤ 50ms throttle) before returning VaultInfo"
    - "Backend emits `vault://index_progress` events with `{ current, total, current_file }` payloads"
    - "Frontend `ProgressBar.svelte` subscribes to `progressStore` and renders the UI-SPEC progress card while `active === true`"
    - "After walk completes, `open_vault` also returns the flat `.md` file list (relative paths, alphabetically sorted)"
    - "VaultView renders the flat file list (D-14), click-a-row → `readFile` → `editorStore.openFile` → `CMEditor.svelte` mounts"
    - "CMEditor.onSave wires to `writeFile` with error handling (toast on failure)"
    - "`indexProgress.test.ts` goes from `it.todo` to passing mock-event assertions"
    - "Manual E2E checkpoint confirms VAULT-01..VAULT-06, IDX-02, EDIT-01, EDIT-02, EDIT-04, EDIT-09, UI-04 all work end-to-end"
  artifacts:
    - path: "src-tauri/src/commands/vault.rs"
      provides: "Updated open_vault with two-pass walk + progress events + file list"
      contains: "vault://index_progress"
    - path: "src/ipc/events.ts"
      provides: "Typed listen() wrappers for vault://index_progress"
      exports: ["listenIndexProgress", "IndexProgressPayload"]
    - path: "src/components/Progress/ProgressBar.svelte"
      provides: "UI-SPEC progress card"
    - path: "src/components/Welcome/VaultView.svelte"
      provides: "Flat file list + editor pane split"
    - path: "src/components/Welcome/FileListRow.svelte"
      provides: "Click-to-open row with active highlight"
  key_links:
    - from: "src-tauri/src/commands/vault.rs::open_vault"
      to: "tauri::Emitter::emit"
      via: "walkdir second pass"
      pattern: "emit\\(\"vault://index_progress\""
    - from: "src/ipc/events.ts::listenIndexProgress"
      to: "src/store/progressStore.ts::update"
      via: "event callback"
      pattern: "progressStore.update"
    - from: "src/components/Welcome/VaultView.svelte"
      to: "src/components/Editor/CMEditor.svelte"
      via: "dynamic mount with `{#key $editorStore.activePath}`"
      pattern: "CMEditor"
    - from: "CMEditor.svelte onSave prop"
      to: "src/ipc/commands.ts::writeFile"
      via: "VaultView wiring"
      pattern: "writeFile\\("
---

<objective>
Close Phase 1 end-to-end: upgrade `open_vault` to perform a two-pass walk (first pass counts, second pass emits `vault://index_progress` events with ≤50ms throttle) and return the full flat `.md` file list (alphabetically sorted, relative paths). Add a typed `listen()` wrapper in `src/ipc/events.ts`. Build the UI-SPEC `ProgressBar.svelte` component and the D-14 flat `VaultView` that renders the file list and mounts `CMEditor.svelte` when a file is opened. Wire `editorStore` + `readFile` + `writeFile` + toast error handling. Upgrade `tests/indexProgress.test.ts` from `it.todo` to passing assertions with a mocked `listen()`. Run the Phase 1 manual E2E checkpoint to confirm every Phase 1 REQ-ID works in a real Tauri dev build.

Purpose: This plan is the glue. Everything prior was components and commands in isolation; this plan connects them into a running app. After this plan, the user can launch `pnpm tauri dev`, pick a vault, watch the progress bar fill, click a `.md` file, see it render in CodeMirror, type something, wait 2 seconds, and see the change on disk. Every Phase 1 success criterion from ROADMAP.md is satisfied.

Output: A demo-able skeleton of VaultCore plus the Phase 1 manual verification checkpoint — the final gate before Phase 2 planning begins.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/01-skeleton/01-CONTEXT.md
@.planning/phases/01-skeleton/01-RESEARCH.md
@.planning/phases/01-skeleton/01-UI-SPEC.md
@.planning/phases/01-skeleton/01-VALIDATION.md
@.planning/phases/01-skeleton/01-00-SUMMARY.md
@.planning/phases/01-skeleton/01-01-SUMMARY.md
@.planning/phases/01-skeleton/01-02-SUMMARY.md
@.planning/phases/01-skeleton/01-03-SUMMARY.md
@src-tauri/src/commands/vault.rs
@src-tauri/src/lib.rs
@src/App.svelte
@src/store/vaultStore.ts
@src/store/progressStore.ts
@src/store/editorStore.ts
@src/store/toastStore.ts
@src/ipc/commands.ts
@src/components/Editor/CMEditor.svelte
@tests/indexProgress.test.ts

<interfaces>
<!-- New backend event contract introduced in this plan -->

// src-tauri/src/commands/vault.rs — updated VaultInfo
#[derive(Serialize, Clone)]
pub struct VaultInfo {
    pub path: String,
    pub file_count: usize,
    pub file_list: Vec<String>, // NEW — relative paths, alphabetically sorted
}

// Event channel
//   name: "vault://index_progress"
//   payload: { current: number, total: number, current_file: string }

// src/ipc/events.ts — typed listener
export interface IndexProgressPayload {
  current: number;
  total: number;
  current_file: string;
}

export function listenIndexProgress(
  handler: (payload: IndexProgressPayload) => void
): Promise<() => void>;
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Backend two-pass walk with progress events + file list return</name>
  <files>src-tauri/src/commands/vault.rs, src-tauri/src/tests/vault_stats.rs, src-tauri/src/lib.rs</files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §2.2 AppHandle::emit, §2.3 throttling, §4.1 walkdir filtering
    - .planning/phases/01-skeleton/01-CONTEXT.md D-21 (real file-walk), D-22 (two-pass), D-14 (flat file list)
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Progress UI" (event cadence: every 250 files OR every 100ms; we use 50ms per RESEARCH §2.3)
    - src-tauri/src/commands/vault.rs (from plan 01-01)
    - src-tauri/src/lib.rs (VaultState)
  </read_first>
  <behavior>
    - `VaultInfo` now contains `file_list: Vec<String>` (relative paths from vault root, alphabetically sorted, forward-slash separators)
    - `open_vault` flow: canonicalize → fs_scope.allow_directory → first-pass count → second-pass walk emitting throttled `vault://index_progress` events → build sorted file list → return `VaultInfo`
    - Events are throttled to ≤ one emit per 50ms, with a forced final emit at `current == total`
    - `current_file` field contains the relative path (e.g., `"subdir/note.md"`), not the absolute path
    - File list uses forward slashes on all platforms for cross-platform consistency (Phase 2 sidebar will use the same format)
    - A new unit test `collect_file_list_sorted` asserts alphabetical sort + forward-slash normalization + dot-dir exclusion
  </behavior>
  <action>
    1. **Update `src-tauri/src/commands/vault.rs`:**

       Add a new helper `collect_file_list` and modify `VaultInfo` + `open_vault`:
       ```rust
       use tauri::{AppHandle, Emitter, Manager};
       use std::time::{Duration, Instant};

       #[derive(Serialize, Clone)]
       pub struct VaultInfo {
           pub path: String,
           pub file_count: usize,
           pub file_list: Vec<String>,
       }

       #[derive(Serialize, Clone)]
       struct IndexProgressPayload {
           current: usize,
           total: usize,
           current_file: String,
       }

       const PROGRESS_THROTTLE: Duration = Duration::from_millis(50);
       const PROGRESS_EVENT: &str = "vault://index_progress";

       /// Collect all `.md` file relative paths from the vault root, alphabetically sorted.
       /// Forward-slash separators on all platforms for cross-platform consistency.
       /// Skips dot-prefixed directories at any depth (D-14 / RESEARCH §4.1).
       pub fn collect_file_list(root: &Path) -> Vec<String> {
           let mut paths: Vec<String> = WalkDir::new(root)
               .follow_links(false)
               .into_iter()
               .filter_entry(|e| !is_excluded(e))
               .filter_map(|e| e.ok())
               .filter(|e| {
                   e.file_type().is_file()
                       && e.path().extension().map_or(false, |ext| ext == "md")
               })
               .filter_map(|e| {
                   e.path()
                       .strip_prefix(root)
                       .ok()
                       .map(|p| p.to_string_lossy().replace('\\', "/"))
               })
               .collect();
           paths.sort();
           paths
       }

       #[tauri::command]
       pub async fn open_vault(
           app: AppHandle,
           state: tauri::State<'_, crate::VaultState>,
           path: String,
       ) -> Result<VaultInfo, VaultError> {
           let p = PathBuf::from(&path);
           let canonical = std::fs::canonicalize(&p).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::VaultUnavailable { path: path.clone() },
               std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
               _ => VaultError::Io(e),
           })?;
           if !canonical.is_dir() {
               return Err(VaultError::VaultUnavailable { path });
           }

           app.fs_scope()
               .allow_directory(&canonical, true)
               .map_err(|e| VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;

           {
               let mut guard = state.current_vault.lock().unwrap();
               *guard = Some(canonical.clone());
           }

           let canonical_str = canonical.to_string_lossy().into_owned();
           push_recent_vault(&app, &canonical_str)?;

           // --- IDX-02 two-pass walk with progress events ---
           let total = count_md_files(&canonical);

           // Pre-collect the sorted file list (single pass over the directory — cheap for Phase 1).
           // This also gives us a stable iteration order for the progress emit.
           let file_list = collect_file_list(&canonical);

           // Emit progress events while iterating (using the same sorted list so progress order
           // matches what the user will see in the flat file list).
           let mut last_emit = Instant::now() - PROGRESS_THROTTLE;
           for (i, relative) in file_list.iter().enumerate() {
               let current = i + 1;
               let should_emit = current == total || last_emit.elapsed() >= PROGRESS_THROTTLE;
               if should_emit {
                   let _ = app.emit(
                       PROGRESS_EVENT,
                       IndexProgressPayload {
                           current,
                           total,
                           current_file: relative.clone(),
                       },
                   );
                   last_emit = Instant::now();
               }
           }

           Ok(VaultInfo {
               path: canonical_str,
               file_count: total,
               file_list,
           })
       }
       ```

    2. **Update `src-tauri/src/tests/vault_stats.rs`** — add `collect_file_list_sorted` test:
       ```rust
       use crate::commands::vault::collect_file_list;

       #[test]
       fn collect_file_list_sorted_and_normalized() {
           let dir = tempdir().unwrap();
           fs::create_dir(dir.path().join("sub")).unwrap();
           fs::write(dir.path().join("b.md"), "").unwrap();
           fs::write(dir.path().join("a.md"), "").unwrap();
           fs::write(dir.path().join("sub/c.md"), "").unwrap();
           fs::write(dir.path().join("ignore.txt"), "").unwrap();
           fs::create_dir(dir.path().join(".hidden")).unwrap();
           fs::write(dir.path().join(".hidden/x.md"), "").unwrap();

           let list = collect_file_list(dir.path());
           assert_eq!(list, vec!["a.md", "b.md", "sub/c.md"]);
       }
       ```

    Verify with `cargo test collect_file_list_sorted_and_normalized` and `cargo build`.
  </action>
  <verify>
    <automated>cd src-tauri &amp;&amp; cargo test collect_file_list_sorted_and_normalized &amp;&amp; cargo build</automated>
  </verify>
  <acceptance_criteria>
    - `src-tauri/src/commands/vault.rs` contains `pub file_list: Vec<String>` in `VaultInfo`
    - `src-tauri/src/commands/vault.rs` contains `pub fn collect_file_list`
    - `src-tauri/src/commands/vault.rs` contains `const PROGRESS_EVENT: &str = "vault://index_progress"`
    - `src-tauri/src/commands/vault.rs` contains `PROGRESS_THROTTLE: Duration = Duration::from_millis(50)`
    - `src-tauri/src/commands/vault.rs` contains `app.emit(PROGRESS_EVENT,` or equivalent
    - `src-tauri/src/commands/vault.rs` contains `.replace('\\', "/")` (forward-slash normalization)
    - `src-tauri/src/commands/vault.rs` contains `paths.sort()`
    - `cargo test --manifest-path src-tauri/Cargo.toml collect_file_list_sorted_and_normalized` exits 0 with 1 passed
    - `cargo build --manifest-path src-tauri/Cargo.toml` exits 0
    - `cargo test --manifest-path src-tauri/Cargo.toml` overall still green
  </acceptance_criteria>
  <done>Backend open_vault performs two-pass walk with throttled progress events, returns sorted relative-path file list with forward-slash separators, cargo tests green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Frontend listen wrapper + ProgressBar + indexProgress.test.ts</name>
  <files>src/ipc/events.ts, src/components/Progress/ProgressBar.svelte, tests/indexProgress.test.ts</files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §2.2 event emission / listening pattern
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Progress UI" (centered card, label "Scanning vault…", counter format, 8px bar, accent fill, 120ms fill transition)
    - src/store/progressStore.ts (from plan 01-02)
    - tests/indexProgress.test.ts (it.todo stubs)
  </read_first>
  <behavior>
    - `listenIndexProgress(handler)` returns an `UnlistenFn`-producing Promise, wraps `@tauri-apps/api/event::listen`
    - `ProgressBar.svelte` subscribes to `progressStore`; renders only when `active === true`; shows label, counter (comma-formatted), fill bar driven by `(current / total) * 100%`, and truncated current-file name
    - `tests/indexProgress.test.ts` mocks `@tauri-apps/api/event` (inline `vi.mock`) and asserts the listener + store transition 0 → N/N → hidden
  </behavior>
  <action>
    1. **Create `src/ipc/events.ts`:**
       ```typescript
       import { listen, type UnlistenFn } from "@tauri-apps/api/event";

       export interface IndexProgressPayload {
         current: number;
         total: number;
         current_file: string;
       }

       export const INDEX_PROGRESS_EVENT = "vault://index_progress";

       export function listenIndexProgress(
         handler: (payload: IndexProgressPayload) => void
       ): Promise<UnlistenFn> {
         return listen<IndexProgressPayload>(INDEX_PROGRESS_EVENT, (event) => {
           handler(event.payload);
         });
       }
       ```

    2. **Create `src/components/Progress/ProgressBar.svelte`:**
       ```svelte
       <script lang="ts">
         import { progressStore } from "../../store/progressStore";

         function formatCount(n: number): string {
           return n.toLocaleString("en-US");
         }

         // Middle-truncate for long paths
         function truncatePath(p: string, max = 48): string {
           if (p.length <= max) return p;
           const half = Math.floor((max - 1) / 2);
           return `${p.slice(0, half)}…${p.slice(p.length - half)}`;
         }
       </script>

       {#if $progressStore.active}
         <div class="vc-progress-overlay" data-testid="progress-overlay">
           <div class="vc-progress-card">
             <p class="vc-progress-label">Scanning vault…</p>
             <p class="vc-progress-counter" data-testid="progress-counter">
               {formatCount($progressStore.current)} / {formatCount($progressStore.total)}
             </p>
             <div class="vc-progress-track" role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax={$progressStore.total}
                  aria-valuenow={$progressStore.current}>
               <div
                 class="vc-progress-fill"
                 data-testid="progress-fill"
                 style:width="{$progressStore.total > 0
                   ? ($progressStore.current / $progressStore.total) * 100
                   : 0}%"
               ></div>
             </div>
             <p class="vc-progress-file" data-testid="progress-file">
               {truncatePath($progressStore.currentFile)}
             </p>
           </div>
         </div>
       {/if}

       <style>
         .vc-progress-overlay {
           position: fixed;
           inset: 0;
           display: flex;
           align-items: center;
           justify-content: center;
           background: var(--color-bg);
           z-index: 100;
         }
         .vc-progress-card {
           width: 400px;
           padding: 48px 32px;
           background: var(--color-surface);
           border: 1px solid var(--color-border);
           border-radius: 8px;
           box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
         }
         .vc-progress-label {
           margin: 0 0 8px 0;
           font-size: 14px;
           color: var(--color-text-muted);
         }
         .vc-progress-counter {
           margin: 0 0 16px 0;
           font-size: 12px;
           color: var(--color-text-muted);
           text-align: right;
         }
         .vc-progress-track {
           width: 100%;
           height: 8px;
           background: var(--color-border);
           border-radius: 4px;
           overflow: hidden;
         }
         .vc-progress-fill {
           height: 100%;
           background: var(--color-accent);
           transition: width 120ms linear;
         }
         .vc-progress-file {
           margin: 8px 0 0 0;
           font-size: 12px;
           color: var(--color-text-muted);
           overflow: hidden;
           text-overflow: ellipsis;
           white-space: nowrap;
         }
       </style>
       ```

    3. **Upgrade `tests/indexProgress.test.ts`:**
       ```typescript
       import { describe, it, expect, beforeEach, vi } from "vitest";
       import { get } from "svelte/store";

       // Mock the Tauri event module BEFORE importing our code that uses it
       const mockListen = vi.fn();
       vi.mock("@tauri-apps/api/event", () => ({
         listen: mockListen,
       }));

       import { listenIndexProgress, INDEX_PROGRESS_EVENT } from "../src/ipc/events";
       import { progressStore } from "../src/store/progressStore";

       beforeEach(() => {
         mockListen.mockReset();
         progressStore.finish();
       });

       describe("IDX-02: vault://index_progress event wiring", () => {
         it("IDX-02: listenIndexProgress subscribes to the correct channel", async () => {
           mockListen.mockResolvedValue(() => {}); // UnlistenFn
           const handler = vi.fn();
           await listenIndexProgress(handler);
           expect(mockListen).toHaveBeenCalledWith(
             INDEX_PROGRESS_EVENT,
             expect.any(Function)
           );
         });

         it("IDX-02: handler receives { current, total, current_file } payload", async () => {
           let capturedCb: ((event: { payload: unknown }) => void) | null = null;
           mockListen.mockImplementation((_name: string, cb: (event: { payload: unknown }) => void) => {
             capturedCb = cb;
             return Promise.resolve(() => {});
           });
           const handler = vi.fn();
           await listenIndexProgress(handler);
           // Simulate a Tauri event
           capturedCb!({
             payload: { current: 5, total: 10, current_file: "notes/a.md" },
           });
           expect(handler).toHaveBeenCalledWith({
             current: 5,
             total: 10,
             current_file: "notes/a.md",
           });
         });

         it("IDX-02: progressStore.start → update → finish flow", () => {
           progressStore.start(100);
           expect(get(progressStore).active).toBe(true);
           expect(get(progressStore).total).toBe(100);
           progressStore.update(50, 100, "a.md");
           expect(get(progressStore).current).toBe(50);
           expect(get(progressStore).active).toBe(true);
           progressStore.update(100, 100, "z.md");
           // update() sets active = current < total
           expect(get(progressStore).active).toBe(false);
         });

         it("IDX-02: progressStore.finish() sets active to false", () => {
           progressStore.start(10);
           progressStore.finish();
           expect(get(progressStore).active).toBe(false);
         });
       });
       ```
  </action>
  <verify>
    <automated>pnpm vitest run tests/indexProgress.test.ts &amp;&amp; pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `src/ipc/events.ts` contains `export function listenIndexProgress` AND `INDEX_PROGRESS_EVENT = "vault://index_progress"` AND imports `listen` from `@tauri-apps/api/event`
    - `src/components/Progress/ProgressBar.svelte` contains `$progressStore.active` AND `Scanning vault…` AND `role="progressbar"` AND `var(--color-accent)` AND `var(--color-surface)` AND `var(--color-border)` AND `width: 120ms` or `transition: width 120ms`
    - `tests/indexProgress.test.ts` does NOT contain `it.todo`
    - `tests/indexProgress.test.ts` contains `vi.mock("@tauri-apps/api/event"`
    - `pnpm vitest run tests/indexProgress.test.ts` exits 0 with at least 4 passed
    - `pnpm typecheck` exits 0
  </acceptance_criteria>
  <done>Event wrapper + ProgressBar component + four IDX-02 assertions green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: VaultView + FileListRow + App.svelte end-to-end wire-up</name>
  <files>
    src/components/Welcome/VaultView.svelte,
    src/components/Welcome/FileListRow.svelte,
    src/App.svelte,
    src/store/progressStore.ts
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Flat File List", "CodeMirror 6 Editor", "Color"
    - .planning/phases/01-skeleton/01-CONTEXT.md D-14 (flat list, no icons, no nesting), D-15 (auto-load does NOT reopen last file)
    - src/App.svelte (from plan 01-02, has placeholder vault-view)
    - src/components/Editor/CMEditor.svelte (from plan 01-03)
    - src/ipc/commands.ts, src/ipc/events.ts, src/store/*.ts
  </read_first>
  <behavior>
    - `VaultView.svelte` splits screen: left column = file list (max-width 280px, scrollable), right = editor pane or "No file selected" placeholder
    - File list shows `$vaultStore.fileList` entries; click a row → call `readFile(vaultPath + "/" + relativePath)` → on success `editorStore.openFile(abs, content)`; on failure toast error and do NOT change editor
    - Active row (matching `$editorStore.activePath`) gets accent left-border + accent-bg
    - Editor pane uses `{#key $editorStore.activePath}` wrapper so switching files unmounts+remounts CMEditor (history reset per RESEARCH §3.2)
    - CMEditor's `onSave` prop wires to a function that calls `writeFile(activePath, text)` with try/catch → toast on failure
    - App.svelte onMount subscribes to `listenIndexProgress` and routes events into `progressStore`; also hides progress when `open_vault` resolves
    - App.svelte renders `<ProgressBar />` on top of Welcome/VaultView (it shows itself only while `active === true`)
    - VAULT-06 satisfied: `VaultInfo.file_count` is displayed somewhere in the VaultView header
  </behavior>
  <action>
    1. **Add a `subscribeRemote` helper to `src/store/progressStore.ts`** (small addition — still classic writable, just exposes the update callable by event listeners):
       ```typescript
       // No change needed — progressStore.update is already exported.
       // Listeners call it directly.
       ```
       (No file change; note in task description — the existing store API is sufficient.)

    2. **`src/components/Welcome/FileListRow.svelte`:**
       ```svelte
       <script lang="ts">
         let {
           path,
           active,
           onOpen,
         }: {
           path: string;
           active: boolean;
           onOpen: (p: string) => void;
         } = $props();
       </script>

       <button
         type="button"
         class="vc-file-row"
         class:active
         data-testid="file-row"
         data-path={path}
         onclick={() => onOpen(path)}
       >
         <span class="vc-file-path">{path}</span>
       </button>

       <style>
         .vc-file-row {
           display: block;
           width: 100%;
           min-height: 32px;
           padding: 8px 16px;
           background: transparent;
           border: none;
           border-left: 2px solid transparent;
           color: var(--color-text);
           font-size: 14px;
           font-family: var(--vc-font-body);
           cursor: pointer;
           text-align: left;
           white-space: nowrap;
           overflow: hidden;
           text-overflow: ellipsis;
         }
         .vc-file-row:hover {
           background: var(--color-accent-bg);
         }
         .vc-file-row.active {
           background: var(--color-accent-bg);
           border-left-color: var(--color-accent);
         }
         .vc-file-path {
           direction: rtl;
           display: inline-block;
           max-width: 100%;
           overflow: hidden;
           text-overflow: ellipsis;
         }
       </style>
       ```

    3. **`src/components/Welcome/VaultView.svelte`:**
       ```svelte
       <script lang="ts">
         import { vaultStore } from "../../store/vaultStore";
         import { editorStore } from "../../store/editorStore";
         import { toastStore } from "../../store/toastStore";
         import { readFile, writeFile } from "../../ipc/commands";
         import { isVaultError, vaultErrorCopy } from "../../types/errors";
         import FileListRow from "./FileListRow.svelte";
         import CMEditor from "../Editor/CMEditor.svelte";

         function joinVaultPath(vault: string, relative: string): string {
           // Vault path is canonical, file list uses forward slashes.
           // Use platform-agnostic concat: Tauri commands on Windows accept / too.
           return `${vault}/${relative}`;
         }

         async function openFile(relative: string): Promise<void> {
           const vaultPath = $vaultStore.currentPath;
           if (!vaultPath) return;
           const absolute = joinVaultPath(vaultPath, relative);
           try {
             const content = await readFile(absolute);
             editorStore.openFile(absolute, content);
           } catch (err) {
             const ve = isVaultError(err)
               ? err
               : { kind: "Io" as const, message: String(err), data: null };
             toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
           }
         }

         async function handleSave(text: string): Promise<void> {
           const activePath = $editorStore.activePath;
           if (!activePath) return;
           try {
             const hash = await writeFile(activePath, text);
             editorStore.setLastSavedHash(hash);
           } catch (err) {
             const ve = isVaultError(err)
               ? err
               : { kind: "Io" as const, message: String(err), data: null };
             toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
           }
         }

         // Synchronous wrapper so CMEditor's `onSave` callback returns void.
         function onSaveSync(text: string): void {
           void handleSave(text);
         }
       </script>

       <main class="vc-vault-view" data-testid="vault-view">
         <header class="vc-vault-header">
           <span class="vc-vault-path" title={$vaultStore.currentPath ?? ""}>
             {$vaultStore.currentPath ?? ""}
           </span>
           <span class="vc-vault-count" data-testid="vault-count">
             {$vaultStore.fileCount} file{$vaultStore.fileCount === 1 ? "" : "s"}
           </span>
         </header>

         <div class="vc-vault-body">
           <aside class="vc-file-list" data-testid="file-list">
             {#each $vaultStore.fileList as path (path)}
               <FileListRow
                 {path}
                 active={$editorStore.activePath === joinVaultPath($vaultStore.currentPath ?? "", path)}
                 onOpen={openFile}
               />
             {/each}
             {#if $vaultStore.fileList.length === 0}
               <p class="vc-empty" data-testid="file-list-empty">No Markdown files in this vault.</p>
             {/if}
           </aside>

           <section class="vc-editor-pane" data-testid="editor-pane">
             {#if $editorStore.activePath}
               {#key $editorStore.activePath}
                 <CMEditor content={$editorStore.content} onSave={onSaveSync} />
               {/key}
             {:else}
               <div class="vc-editor-empty">
                 <p>No file selected.</p>
                 <p class="vc-editor-empty-hint">Click a file in the list to open it.</p>
               </div>
             {/if}
           </section>
         </div>
       </main>

       <style>
         .vc-vault-view {
           display: flex;
           flex-direction: column;
           height: 100vh;
           background: var(--color-bg);
         }
         .vc-vault-header {
           display: flex;
           justify-content: space-between;
           align-items: center;
           padding: 8px 16px;
           border-bottom: 1px solid var(--color-border);
           background: var(--color-surface);
           font-size: 14px;
           color: var(--color-text);
         }
         .vc-vault-path {
           max-width: 60%;
           overflow: hidden;
           text-overflow: ellipsis;
           white-space: nowrap;
         }
         .vc-vault-count {
           font-size: 12px;
           color: var(--color-text-muted);
         }
         .vc-vault-body {
           display: grid;
           grid-template-columns: minmax(200px, 280px) 1fr;
           flex: 1;
           min-height: 0;
         }
         .vc-file-list {
           overflow-y: auto;
           border-right: 1px solid var(--color-border);
           background: var(--color-surface);
         }
         .vc-empty {
           padding: 16px;
           font-size: 12px;
           color: var(--color-text-muted);
         }
         .vc-editor-pane {
           overflow: hidden;
           background: var(--color-surface);
         }
         .vc-editor-empty {
           display: flex;
           flex-direction: column;
           align-items: center;
           justify-content: center;
           height: 100%;
           color: var(--color-text-muted);
           font-size: 14px;
         }
         .vc-editor-empty-hint {
           font-size: 12px;
           margin-top: 8px;
         }
       </style>
       ```

    4. **Update `src/App.svelte`** — replace the placeholder vault-view with `<VaultView />`, wire the progress listener, and populate the file list from `VaultInfo`:
       ```svelte
       <script lang="ts">
         import { onMount, onDestroy } from "svelte";
         import { vaultStore } from "./store/vaultStore";
         import { toastStore } from "./store/toastStore";
         import { progressStore } from "./store/progressStore";
         import {
           getRecentVaults,
           openVault,
           pickVaultFolder,
         } from "./ipc/commands";
         import { listenIndexProgress } from "./ipc/events";
         import { vaultErrorCopy, isVaultError } from "./types/errors";
         import type { RecentVault } from "./types/vault";
         import WelcomeScreen from "./components/Welcome/WelcomeScreen.svelte";
         import VaultView from "./components/Welcome/VaultView.svelte";
         import ToastContainer from "./components/Toast/ToastContainer.svelte";
         import ProgressBar from "./components/Progress/ProgressBar.svelte";

         let recent: RecentVault[] = $state([]);
         let unlistenProgress: (() => void) | null = null;

         async function loadVault(path: string): Promise<void> {
           vaultStore.setOpening(path);
           progressStore.start(0);
           try {
             const info = await openVault(path);
             vaultStore.setReady({
               currentPath: info.path,
               fileList: info.file_list,
               fileCount: info.file_count,
             });
             progressStore.finish();
             recent = await getRecentVaults();
           } catch (err) {
             progressStore.finish();
             const ve = isVaultError(err)
               ? err
               : { kind: "Io" as const, message: String(err), data: null };
             vaultStore.setError(vaultErrorCopy(ve));
             toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
           }
         }

         async function handlePickVault(): Promise<void> {
           try {
             const picked = await pickVaultFolder();
             if (picked !== null) {
               await loadVault(picked);
             }
           } catch (err) {
             const ve = isVaultError(err)
               ? err
               : { kind: "Io" as const, message: String(err), data: null };
             toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
           }
         }

         function handleOpenRecent(path: string): void {
           void loadVault(path);
         }

         onMount(async () => {
           // Subscribe to progress events before any vault open happens
           unlistenProgress = await listenIndexProgress((payload) => {
             progressStore.update(payload.current, payload.total, payload.current_file);
           });

           // VAULT-03: auto-load last reachable vault
           try {
             recent = await getRecentVaults();
             const last = recent[0];
             if (last) {
               await loadVault(last.path);
             }
           } catch (err) {
             const ve = isVaultError(err)
               ? err
               : { kind: "Io" as const, message: String(err), data: null };
             toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
           }
         });

         onDestroy(() => {
           unlistenProgress?.();
         });
       </script>

       {#if $vaultStore.status === "ready"}
         <VaultView />
       {:else}
         <WelcomeScreen {recent} onOpenVault={handleOpenRecent} onPickVault={handlePickVault} />
       {/if}

       <ProgressBar />
       <ToastContainer />
       ```

    Run `pnpm typecheck && pnpm build && pnpm vitest run` to confirm the whole frontend still compiles and every earlier test still passes.
  </action>
  <verify>
    <automated>pnpm typecheck &amp;&amp; pnpm build &amp;&amp; pnpm vitest run</automated>
  </verify>
  <acceptance_criteria>
    - `src/components/Welcome/VaultView.svelte` contains `readFile(` AND `writeFile(` AND `editorStore.openFile` AND `CMEditor` AND `{#key $editorStore.activePath}`
    - `src/components/Welcome/VaultView.svelte` contains `$vaultStore.fileList` AND `$vaultStore.fileCount` AND `data-testid="file-list"` AND `data-testid="editor-pane"` AND `data-testid="vault-count"`
    - `src/components/Welcome/FileListRow.svelte` contains `class:active` AND `var(--color-accent)` AND `var(--color-accent-bg)`
    - `src/App.svelte` contains `listenIndexProgress` AND `progressStore.update` AND `progressStore.start` AND `progressStore.finish` AND `<VaultView />` AND `<ProgressBar />` AND `unlistenProgress`
    - `src/App.svelte` does NOT reference `invoke(` directly
    - `grep -c "file_list: info.file_list\\|fileList: info.file_list" src/App.svelte` returns at least 1
    - `pnpm typecheck` exits 0
    - `pnpm build` exits 0
    - `pnpm vitest run` exits 0 overall (keymap 6 + autoSave 4 + Toast 6 + WelcomeScreen 6 + vault 9 + indexProgress 4 = 35+ tests green)
  </acceptance_criteria>
  <done>VaultView renders file list, mounts CMEditor on click, auto-save flows through writeFile, progress events drive the ProgressBar. Full end-to-end wiring complete. 35+ Vitest assertions green.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Phase 1 manual E2E verification — ROADMAP success criteria</name>
  <files>(no file changes — verification checkpoint only)</files>
  <action>
    This is the Phase 1 gate checkpoint — no file changes. Pause execution and run the manual verification steps below against a real `pnpm tauri dev` build. Every ROADMAP Phase 1 success criterion (1–5), the D-17 non-UTF-8 check, and the SEC-01 zero-network check must pass. Type "approved" to mark Phase 1 complete, or describe issues for remediation.
  </action>
  <what-built>
    Full Phase 1 skeleton running end-to-end: Tauri 2 + Svelte 5 + CM6 + Tailwind v4, Welcome screen with recent list, native folder picker, two-pass walk with real progress events, flat file list, CodeMirror 6 editor with minimal live-preview + GFM + CSS-variable theme, Cmd/Ctrl+B/I/K wraps, 2s idle auto-save, full VaultError enum + toast surface, auto-load-last-vault with VAULT-05 fallback, VAULT-06 file count displayed in vault header.
  </what-built>
  <how-to-verify>
    Prepare a small test vault first:
    ```
    mkdir -p /tmp/vaultcore-test/{folder-a,folder-b}
    printf "# Hello\n\n**bold** and *italic* and `code`.\n\n- list item 1\n- list item 2\n\n## Subsection\n\nBody text.\n" > /tmp/vaultcore-test/note.md
    printf "# Second note\n\nContent here.\n" > /tmp/vaultcore-test/folder-a/second.md
    printf "# Third\n" > /tmp/vaultcore-test/folder-b/third.md
    # Non-UTF-8 file for D-17 check
    printf '\xff\xfe\x00\x01VaultCore' > /tmp/vaultcore-test/binary.md
    ```

    Then run: `pnpm tauri dev`

    **ROADMAP Phase 1 Success Criterion 1:** Welcome screen appears with "VaultCore" heading, "Open vault" button, and "RECENT VAULTS" section showing "No recent vaults" on first launch. Copy exactly matches UI-SPEC.

    **Success Criterion 2:**
    - Click "Open vault" → native OS folder dialog opens
    - Pick `/tmp/vaultcore-test` → dialog closes, progress card appears with "Scanning vault…" label and counter reaches 3/3 (or 4/4 if binary.md is not excluded), progress card disappears, VaultView renders
    - Vault header shows the path and file count
    - File list shows `binary.md`, `folder-a/second.md`, `folder-b/third.md`, `note.md` in alphabetical order (forward-slash separated)
    - Close the app, run `pnpm tauri dev` again — the vault auto-loads and you land directly in the VaultView without seeing the Welcome screen

    **Success Criterion 3:**
    - Click `note.md` → editor renders with `# Hello` shown as a visibly larger heading, `**bold**` visibly bolder, `*italic*` italicized, `` `code` `` in monospace with subtle background, bullet list rendered as a list
    - Keystroke test: type rapidly for several seconds → no visible lag, cursor moves smoothly at what feels like 60fps (PERF-04 guardrail, not formally measured in Phase 1)
    - Switch to `folder-a/second.md` by clicking it → editor switches instantly, history resets (Cmd+Z does not undo into the previous file)

    **Success Criterion 4:**
    - Open `note.md`, select the word "bold" in `**bold**` (select just "bold", not the asterisks), press Cmd/Ctrl+B → the asterisks are removed (toggle off)
    - Press Cmd/Ctrl+B again with the same selection → asterisks re-added
    - Select a plain word, press Cmd/Ctrl+I → wrapped with `*...*`
    - Place cursor on a plain word, press Cmd/Ctrl+K → becomes `[word](url)` with cursor inside `(url)`
    - Type some new content. Wait 2 seconds. Run `cat /tmp/vaultcore-test/note.md` in a separate terminal — the changes are on disk.
    - Verify there is NO dirty indicator, NO save button, NO "Saved" flash

    **Success Criterion 5:** (VAULT-05 unreachable fallback)
    - Close the app
    - Rename `/tmp/vaultcore-test` to `/tmp/vaultcore-test-moved`
    - Run `pnpm tauri dev` again — the app does NOT crash, lands on the Welcome screen, and shows a toast saying "Vault unavailable. Check that the folder is still mounted." (or similar VaultError copy)
    - Dismiss the toast; the Welcome screen shows the recent vault (pointing at the old path) but clicking it reproduces the toast without crashing

    **D-17 / T-03 non-UTF-8 check:**
    - Rename the vault back: `mv /tmp/vaultcore-test-moved /tmp/vaultcore-test`
    - Open the vault via Welcome → click `binary.md` → a toast appears saying "Cannot open this file. It contains non-UTF-8 characters." The editor remains on whatever file was previously open (or stays in the "No file selected" state). Run `xxd /tmp/vaultcore-test/binary.md` — the file is UNCHANGED (bytes `ff fe 00 01 56 61 75 6c ...`).

    **Zero-network check (SEC-01 guardrail):**
    - While the app is running, in a separate terminal: `lsof -p $(pgrep -f vaultcore) 2>/dev/null | grep -E "TCP|UDP"` — expect no network sockets (or only local IPC if Tauri uses any)
    - Alternative: `ss -nap 2>/dev/null | grep vaultcore` — expect no non-loopback sockets

    **Zero-regression check:**
    - Run `pnpm vitest run` one more time — full suite green
    - Run `cargo test --manifest-path src-tauri/Cargo.toml` — full suite green
  </how-to-verify>
  <verify>
    <automated>pnpm typecheck &amp;&amp; pnpm vitest run &amp;&amp; pnpm build &amp;&amp; cargo test --manifest-path src-tauri/Cargo.toml</automated>
  </verify>
  <done>Human has typed "approved" after completing every manual verification step above — all ROADMAP Phase 1 success criteria, the D-17 non-UTF-8 check, and the SEC-01 zero-network check pass.</done>
  <resume-signal>Type "approved" to mark Phase 1 complete, or describe issues for remediation</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Rust `open_vault` → frontend event listener | Backend emits `vault://index_progress` payloads with user-path-derived `current_file` strings |
| File list click → `readFile(absolute)` | Frontend constructs an absolute path by joining vault + relative — must stay inside the vault |
| Editor onSave → `writeFile(absolute, content)` | Rapid 2s-cadence writes of editor content back to disk |
| Progress event cadence | DoS potential if walkdir emits tens of thousands of events |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-05 | Spoofing (event channel) | `vault://index_progress` | mitigate | Task 1: only `src-tauri/src/commands/vault.rs::open_vault` calls `app.emit(PROGRESS_EVENT, ...)`. Task 2's acceptance criterion greps to confirm no other source file emits on that channel. Desktop process isolation means no external process can spoof the channel. |
| T-05-D | DoS (event flood) | `open_vault` two-pass walk | mitigate | Task 1: events are throttled to ≤ 1/50ms. A 100k-file vault produces at most ~20 events/second × walk duration. With forced final emit at `current == total`. Accepted IPC overhead per RESEARCH §2.3. |
| T-02 | Information Disclosure (file-list path join) | `VaultView::joinVaultPath` | mitigate | Task 3: the join helper uses forward-slash concat with the backend-canonicalized vault root. The `readFile` and `writeFile` commands in plan 01-01 re-canonicalize and re-check `starts_with(vault)` — so even if the frontend constructs a malicious path, Rust refuses it. Defense in depth: the frontend is NOT the authority here. |
| T-03 | Tampering (binary corruption via auto-save) | Full read→edit→write loop | mitigate | End-to-end: `readFile` refuses non-UTF-8 (plan 01-01), so non-UTF-8 bytes never reach `editorStore.content`, so `autoSaveExtension` never sees them. Task 4 human verification confirms `xxd binary.md` shows unchanged bytes after opening and closing the app. |
| T-03-R | Repudiation (silent save failure) | `VaultView::handleSave` | mitigate | Task 3: `handleSave` wraps `writeFile` in try/catch and pushes an error toast on failure. The user always knows when a save fails. |
| T-04 | Tampering (JSON injection via recent-vaults) | Unchanged from plan 01-01 | accept | Already mitigated by serde_json serialization in plan 01-01. No new code in this plan touches `recent-vaults.json` directly. |
| T-06 | Zero-network guarantee | Full Phase 1 frontend + backend | mitigate | Task 4 human verification includes an `lsof`/`ss` check for network sockets. Additionally, acceptance criteria in every prior plan have grepped for `http://`, `https://`, `cdn.`, `googleapis.com` — zero hits across the codebase. SEC-01 compliance for the Phase 1 skeleton. |
| T-04-I | Information Disclosure (progress event leaks internal path) | `current_file` payload | mitigate | Task 1: `current_file` is the *relative* path (from vault root), NOT the absolute path. This avoids leaking the user's home dir layout to any future extension that hooks the event. |
</threat_model>

<verification>
- Full Vitest suite green: `pnpm vitest run` exits 0 with 35+ passed tests
- Full cargo test suite green: `cargo test --manifest-path src-tauri/Cargo.toml` exits 0
- `pnpm build` green
- `pnpm typecheck` green
- Task 4 human verification checkpoint approved (every ROADMAP Phase 1 success criterion verified end-to-end)
- No network sockets opened by running app (lsof/ss check in Task 4)
- binary.md on disk unchanged after open-and-close cycle (D-17 / T-03 check)
</verification>

<success_criteria>
1. Every Phase 1 ROADMAP success criterion (1–5) passes in Task 4 manual verification
2. IDX-02 real progress events wired (backend emits, frontend listens, store updates, bar renders)
3. Flat file list renders alphabetically with forward-slash separators and click-to-open
4. CMEditor mounts per-file via `{#key}` so history resets between files
5. Auto-save writes through `writeFile` with error-toast fallback
6. VAULT-05 fallback verified: unreachable last vault → Welcome + toast, no crash
7. D-17 verified: binary file is rejected at read and its on-disk bytes stay unchanged
8. T-06 / SEC-01 verified: no network sockets opened
9. Full Vitest + cargo test suites green
</success_criteria>

<output>
After completion, create `.planning/phases/01-skeleton/01-04-SUMMARY.md` per summary template, plus a phase-level `.planning/phases/01-skeleton/PHASE-SUMMARY.md` summarizing the full Phase 1 deliverables against every REQ-ID.
</output>
