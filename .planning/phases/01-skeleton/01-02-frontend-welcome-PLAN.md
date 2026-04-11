---
phase: 01-skeleton
plan: 02
type: execute
wave: 2
depends_on:
  - "01-skeleton/00"
  - "01-skeleton/01"
files_modified:
  - src/types/errors.ts
  - src/types/vault.ts
  - src/ipc/commands.ts
  - src/store/vaultStore.ts
  - src/store/editorStore.ts
  - src/store/toastStore.ts
  - src/store/progressStore.ts
  - src/components/Toast/Toast.svelte
  - src/components/Toast/ToastContainer.svelte
  - src/components/Welcome/WelcomeScreen.svelte
  - src/components/Welcome/RecentVaultRow.svelte
  - src/App.svelte
  - tests/vault.test.ts
  - tests/WelcomeScreen.test.ts
  - tests/Toast.test.ts
autonomous: true
requirements:
  - VAULT-01
  - VAULT-02
  - VAULT-03
  - VAULT-04
  - VAULT-05
  - UI-04
must_haves:
  truths:
    - "Typed `VaultError` interface mirrors the Rust enum's serialized shape"
    - "`src/ipc/commands.ts` wraps every Tauri `invoke` call — no `invoke()` appears in components"
    - "`vaultStore` (classic writable per D-06/RC-01) tracks currentPath/status/fileList/errorMessage"
    - "Welcome screen renders exactly the UI-SPEC layout (centered card, heading, tagline, CTA, divider, recent list, empty state)"
    - "Toast component renders error/conflict/clean-merge variants with UI-SPEC colors and icons, auto-dismisses at 5000ms, caps at 3"
    - "On app mount, the last reachable vault is auto-loaded; an unreachable vault falls back to Welcome + error toast (VAULT-03/VAULT-05)"
    - "Vitest tests for vault.test.ts, WelcomeScreen.test.ts, Toast.test.ts go from `it.todo` to `it(...)` with passing assertions"
  artifacts:
    - path: "src/types/errors.ts"
      provides: "VaultError TS interface matching Rust serialized shape"
      contains: "kind"
    - path: "src/types/vault.ts"
      provides: "VaultInfo, VaultStats, RecentVault TS interfaces"
      contains: "RecentVault"
    - path: "src/ipc/commands.ts"
      provides: "Typed invoke wrappers for all five backend commands"
      exports: ["openVault", "getRecentVaults", "getVaultStats", "readFile", "writeFile"]
    - path: "src/store/vaultStore.ts"
      provides: "Classic writable store with typed actions"
      exports: ["vaultStore"]
    - path: "src/store/editorStore.ts"
      provides: "Editor state store"
      exports: ["editorStore"]
    - path: "src/store/toastStore.ts"
      provides: "Toast queue with variant + auto-dismiss + cap-at-3"
      exports: ["toastStore"]
    - path: "src/components/Welcome/WelcomeScreen.svelte"
      provides: "UI-SPEC-compliant Welcome card"
    - path: "src/components/Toast/ToastContainer.svelte"
      provides: "Stacked toast renderer"
  key_links:
    - from: "src/App.svelte"
      to: "src/store/vaultStore.ts"
      via: "$vaultStore subscription, conditional render Welcome vs VaultView placeholder"
      pattern: "\\$vaultStore"
    - from: "src/ipc/commands.ts"
      to: "@tauri-apps/api/core"
      via: "invoke"
      pattern: "invoke<"
    - from: "src/components/Welcome/WelcomeScreen.svelte"
      to: "src/ipc/commands.ts::openVault"
      via: "click handler on Open Vault button"
      pattern: "openVault\\("
    - from: "src/App.svelte onMount"
      to: "src/ipc/commands.ts::getRecentVaults + openVault"
      via: "auto-load last vault flow (VAULT-03)"
      pattern: "getRecentVaults"
---

<objective>
Build the frontend spine that sits on top of Wave 1's Rust backend: typed IPC wrappers, three Svelte writable stores (vault, editor, toast) using classic `writable` per D-06/RC-01 (explicitly NOT `$state` class stores), the UI-SPEC-compliant Welcome screen with recent-vault list and empty state, the Toast component with three variants, and the auto-load-last-vault-on-mount flow with VAULT-05 fallback to Welcome + error toast. Upgrade the Wave 0 `it.todo` tests for `vault.test.ts`, `WelcomeScreen.test.ts`, and `Toast.test.ts` to real assertions.

Purpose: After this plan, the app runs end-to-end for VAULT-01 through VAULT-05 and UI-04. The user can launch VaultCore, see the Welcome card, click Open Vault, pick a folder, and land in a vault view (where Wave 3/4 will mount the editor and file list). An unreachable last-opened vault falls back cleanly. The Welcome screen matches the UI-SPEC pixel-for-pixel (CSS variables, spacing tokens, copy).

Output: A running Tauri app with Welcome → OpenVault → placeholder VaultView flow, wired to the real Rust commands, plus green Vitest coverage for everything that can be unit-tested (excluding VAULT-03 which is manual-only per VALIDATION.md).
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
@src/styles/tailwind.css
@src/App.svelte
@src-tauri/src/commands/vault.rs
@src-tauri/src/commands/files.rs
@src-tauri/src/error.rs
@tests/vault.test.ts
@tests/WelcomeScreen.test.ts
@tests/Toast.test.ts

<interfaces>
<!-- These are the command signatures published by plan 01-01 (Wave 1). -->
<!-- Frontend MUST consume them verbatim — no new shapes. -->

// From src-tauri/src/commands/vault.rs:
//   VaultInfo { path: string, file_count: number }
//   VaultStats { path: string, file_count: number }
//   RecentVault { path: string, last_opened: string }
//   invoke('open_vault', { path }) → VaultInfo | throws VaultError
//   invoke('get_recent_vaults') → RecentVault[] | throws VaultError
//   invoke('get_vault_stats', { path }) → VaultStats | throws VaultError
//   invoke('read_file', { path }) → string | throws VaultError
//   invoke('write_file', { path, content }) → string (sha256 hex) | throws VaultError

// Error shape (from Wave 1 serde::Serialize impl):
//   { kind: "FileNotFound" | "PermissionDenied" | "DiskFull" | "IndexCorrupt"
//          | "VaultUnavailable" | "MergeConflict" | "InvalidEncoding" | "Io",
//     message: string,
//     data: string | null }

// UI-SPEC references (authoritative for this plan):
//   CSS vars: --color-bg, --color-surface, --color-border, --color-text, --color-text-muted,
//             --color-accent, --color-accent-bg, --color-error, --color-warning, --color-success
//   Spacing: xs=4 sm=8 md=16 lg=24 xl=32 2xl=48 3xl=64 (use Tailwind arbitrary values or CSS vars)
//   Typography: body=14/400, label=12/400, heading=20/700
//   Welcome card: max-width 480px, 32px horizontal padding, 48px vertical padding, 8px radius, `0 1px 3px rgba(0,0,0,0.08)`
//   Toast: 320px wide, 8px radius, 4px left border in variant color, 12px padding, bottom-right 16px, 8px gap, max 3, auto-dismiss 5000ms
//   Copy: "VaultCore", "A faster Markdown workspace for large vaults.", "Open vault", "RECENT VAULTS", "No recent vaults", "Open a folder to get started."
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Types + IPC wrappers + four Svelte writable stores</name>
  <files>
    src/types/errors.ts, src/types/vault.ts,
    src/ipc/commands.ts,
    src/store/vaultStore.ts, src/store/editorStore.ts,
    src/store/toastStore.ts, src/store/progressStore.ts,
    tests/vault.test.ts
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §2.1 (VaultError TS interface), §4.4 (recent vaults client flow), §5 (Svelte stores pattern — classic writable)
    - .planning/phases/01-skeleton/01-CONTEXT.md D-06 (classic writable, NOT $state class stores), D-08 (store file paths), D-20 (plugin-dialog, plugin-fs)
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Toast System" (variant/icon/border-color/auto-dismiss/stack cap)
    - tests/vault.test.ts (current it.todo stubs)
    - src-tauri/src/commands/vault.rs (reference for typed shapes — VaultInfo, RecentVault, etc.)
  </read_first>
  <behavior>
    - vaultStore actions: `setOpening(path)`, `setReady({ currentPath, fileList })`, `setError(errorMessage)`, `reset()`
    - editorStore actions: `openFile(path, content)`, `setContent(content)`, `setLastSavedHash(hash)`, `close()`
    - toastStore actions: `push({ variant, message })` returns id, `dismiss(id)`, auto-dismiss after 5000ms, cap at 3 (oldest dropped)
    - progressStore actions: `start()`, `update(current, total, currentFile)`, `finish()` — consumed by plan 01-04
    - IPC wrappers catch the error thrown by `invoke`, normalize it to `VaultError`, and re-throw with the typed shape
  </behavior>
  <action>
    1. **`src/types/errors.ts`:**
       ```typescript
       export type VaultErrorKind =
         | "FileNotFound"
         | "PermissionDenied"
         | "DiskFull"
         | "IndexCorrupt"
         | "VaultUnavailable"
         | "MergeConflict"
         | "InvalidEncoding"
         | "Io";

       export interface VaultError {
         kind: VaultErrorKind;
         message: string;
         data: string | null;
       }

       export function isVaultError(x: unknown): x is VaultError {
         return (
           typeof x === "object" &&
           x !== null &&
           "kind" in x &&
           "message" in x &&
           typeof (x as VaultError).kind === "string"
         );
       }

       /** UI-SPEC copy map — single source of truth for error toast text. */
       export function vaultErrorCopy(err: VaultError): string {
         switch (err.kind) {
           case "FileNotFound":
             return "Vault not found. The folder may have been moved or deleted.";
           case "PermissionDenied":
             return "Permission denied. VaultCore cannot read this folder.";
           case "DiskFull":
             return "Disk full. Could not save changes.";
           case "VaultUnavailable":
             return "Vault unavailable. Check that the folder is still mounted.";
           case "InvalidEncoding":
             return "Cannot open this file. It contains non-UTF-8 characters.";
           case "Io":
             return "File system error. Check the folder and try again.";
           case "IndexCorrupt":
             return "Index corrupt. VaultCore will rebuild it.";
           case "MergeConflict":
             return `Conflict in ${err.data ?? "file"} — local version kept.`;
         }
       }
       ```

    2. **`src/types/vault.ts`:**
       ```typescript
       export interface VaultInfo {
         path: string;
         file_count: number;
       }

       export interface VaultStats {
         path: string;
         file_count: number;
       }

       export interface RecentVault {
         path: string;
         last_opened: string;
       }

       export type VaultStatus = "idle" | "opening" | "indexing" | "ready" | "error";
       ```

    3. **`src/ipc/commands.ts`:**
       ```typescript
       import { invoke } from "@tauri-apps/api/core";
       import { open as openDialog } from "@tauri-apps/plugin-dialog";
       import type { VaultError } from "../types/errors";
       import type { VaultInfo, VaultStats, RecentVault } from "../types/vault";
       import { isVaultError } from "../types/errors";

       function normalizeError(err: unknown): VaultError {
         if (isVaultError(err)) return err;
         return {
           kind: "Io",
           message: typeof err === "string" ? err : String(err),
           data: null,
         };
       }

       /** VAULT-01: prompt user via native folder dialog. Returns null if cancelled. */
       export async function pickVaultFolder(): Promise<string | null> {
         const picked = await openDialog({
           directory: true,
           multiple: false,
           title: "Open vault",
         });
         if (picked === null) return null;
         if (Array.isArray(picked)) return picked[0] ?? null;
         return picked as string;
       }

       export async function openVault(path: string): Promise<VaultInfo> {
         try {
           return await invoke<VaultInfo>("open_vault", { path });
         } catch (e) {
           throw normalizeError(e);
         }
       }

       export async function getRecentVaults(): Promise<RecentVault[]> {
         try {
           return await invoke<RecentVault[]>("get_recent_vaults");
         } catch (e) {
           throw normalizeError(e);
         }
       }

       export async function getVaultStats(path: string): Promise<VaultStats> {
         try {
           return await invoke<VaultStats>("get_vault_stats", { path });
         } catch (e) {
           throw normalizeError(e);
         }
       }

       export async function readFile(path: string): Promise<string> {
         try {
           return await invoke<string>("read_file", { path });
         } catch (e) {
           throw normalizeError(e);
         }
       }

       export async function writeFile(path: string, content: string): Promise<string> {
         try {
           return await invoke<string>("write_file", { path, content });
         } catch (e) {
           throw normalizeError(e);
         }
       }
       ```

    4. **`src/store/vaultStore.ts`** — classic writable, NOT `$state` class (RC-01):
       ```typescript
       import { writable } from "svelte/store";
       import type { VaultStatus } from "../types/vault";

       export interface VaultState {
         currentPath: string | null;
         status: VaultStatus;
         fileList: string[];
         fileCount: number;
         errorMessage: string | null;
       }

       const initial: VaultState = {
         currentPath: null,
         status: "idle",
         fileList: [],
         fileCount: 0,
         errorMessage: null,
       };

       const _store = writable<VaultState>({ ...initial });

       export const vaultStore = {
         subscribe: _store.subscribe,
         setOpening(path: string): void {
           _store.update((s) => ({ ...s, currentPath: path, status: "opening", errorMessage: null }));
         },
         setIndexing(fileCount: number): void {
           _store.update((s) => ({ ...s, status: "indexing", fileCount }));
         },
         setReady(args: { currentPath: string; fileList: string[]; fileCount: number }): void {
           _store.update((s) => ({
             ...s,
             currentPath: args.currentPath,
             status: "ready",
             fileList: args.fileList,
             fileCount: args.fileCount,
             errorMessage: null,
           }));
         },
         setError(errorMessage: string): void {
           _store.update((s) => ({ ...s, status: "error", errorMessage }));
         },
         reset(): void {
           _store.set({ ...initial });
         },
       };
       ```

    5. **`src/store/editorStore.ts`:**
       ```typescript
       import { writable } from "svelte/store";

       export interface EditorState {
         activePath: string | null;
         content: string;
         lastSavedHash: string | null;
       }

       const _store = writable<EditorState>({
         activePath: null,
         content: "",
         lastSavedHash: null,
       });

       export const editorStore = {
         subscribe: _store.subscribe,
         openFile(path: string, content: string): void {
           _store.set({ activePath: path, content, lastSavedHash: null });
         },
         setContent(content: string): void {
           _store.update((s) => ({ ...s, content }));
         },
         setLastSavedHash(hash: string): void {
           _store.update((s) => ({ ...s, lastSavedHash: hash }));
         },
         close(): void {
           _store.set({ activePath: null, content: "", lastSavedHash: null });
         },
       };
       ```

    6. **`src/store/toastStore.ts`** — UI-04: cap at 3, auto-dismiss 5000ms:
       ```typescript
       import { writable } from "svelte/store";

       export type ToastVariant = "error" | "conflict" | "clean-merge";

       export interface Toast {
         id: number;
         variant: ToastVariant;
         message: string;
       }

       const MAX_TOASTS = 3;
       const AUTO_DISMISS_MS = 5000;

       let nextId = 1;
       const _store = writable<Toast[]>([]);
       const timers = new Map<number, ReturnType<typeof setTimeout>>();

       function scheduleDismiss(id: number) {
         const t = setTimeout(() => {
           dismiss(id);
         }, AUTO_DISMISS_MS);
         timers.set(id, t);
       }

       function dismiss(id: number) {
         const timer = timers.get(id);
         if (timer) clearTimeout(timer);
         timers.delete(id);
         _store.update((toasts) => toasts.filter((t) => t.id !== id));
       }

       export const toastStore = {
         subscribe: _store.subscribe,
         push(args: { variant: ToastVariant; message: string }): number {
           const id = nextId++;
           const toast: Toast = { id, ...args };
           _store.update((toasts) => {
             const next = [...toasts, toast];
             // Drop oldest if over cap
             while (next.length > MAX_TOASTS) {
               const dropped = next.shift()!;
               const t = timers.get(dropped.id);
               if (t) clearTimeout(t);
               timers.delete(dropped.id);
             }
             return next;
           });
           scheduleDismiss(id);
           return id;
         },
         dismiss,
         /** Test-only — resets state between tests */
         _reset(): void {
           for (const t of timers.values()) clearTimeout(t);
           timers.clear();
           nextId = 1;
           _store.set([]);
         },
       };
       ```

    7. **`src/store/progressStore.ts`** — skeleton for plan 01-04:
       ```typescript
       import { writable } from "svelte/store";

       export interface ProgressState {
         active: boolean;
         current: number;
         total: number;
         currentFile: string;
       }

       const _store = writable<ProgressState>({
         active: false,
         current: 0,
         total: 0,
         currentFile: "",
       });

       export const progressStore = {
         subscribe: _store.subscribe,
         start(total: number): void {
           _store.set({ active: true, current: 0, total, currentFile: "" });
         },
         update(current: number, total: number, currentFile: string): void {
           _store.set({ active: current < total, current, total, currentFile });
         },
         finish(): void {
           _store.update((s) => ({ ...s, active: false }));
         },
       };
       ```

    8. **Upgrade `tests/vault.test.ts`** — replace the `it.todo` stubs with real assertions (skip the VAULT-01 native-dialog one, which needs a mock in Task 2):

       ```typescript
       import { describe, it, expect, beforeEach, vi } from "vitest";
       import { get } from "svelte/store";
       import { vaultStore } from "../src/store/vaultStore";
       import { toastStore } from "../src/store/toastStore";

       beforeEach(() => {
         vaultStore.reset();
         toastStore._reset();
       });

       describe("VAULT-02 / VAULT-04 / VAULT-05 store logic", () => {
         it("VAULT-02: vaultStore starts idle with empty fileList", () => {
           const s = get(vaultStore);
           expect(s.status).toBe("idle");
           expect(s.fileList).toEqual([]);
           expect(s.currentPath).toBeNull();
         });

         it("VAULT-05: setError transitions to error and records message", () => {
           vaultStore.setError("Vault unavailable. Check that the folder is still mounted.");
           const s = get(vaultStore);
           expect(s.status).toBe("error");
           expect(s.errorMessage).toContain("Vault unavailable");
         });

         it("VAULT-05: reset returns to idle with empty state", () => {
           vaultStore.setError("boom");
           vaultStore.reset();
           const s = get(vaultStore);
           expect(s.status).toBe("idle");
           expect(s.errorMessage).toBeNull();
         });

         it("VAULT-04: setReady populates currentPath + fileList + ready status", () => {
           vaultStore.setReady({ currentPath: "/tmp/v", fileList: ["a.md", "b.md"], fileCount: 2 });
           const s = get(vaultStore);
           expect(s.status).toBe("ready");
           expect(s.currentPath).toBe("/tmp/v");
           expect(s.fileList).toEqual(["a.md", "b.md"]);
           expect(s.fileCount).toBe(2);
         });

         it("VAULT-04: status transitions opening → ready via setReady", () => {
           vaultStore.setOpening("/tmp/v");
           expect(get(vaultStore).status).toBe("opening");
           vaultStore.setReady({ currentPath: "/tmp/v", fileList: [], fileCount: 0 });
           expect(get(vaultStore).status).toBe("ready");
         });
       });

       describe("UI-04 toast store", () => {
         it("UI-04: push returns an id and adds one toast", () => {
           const id = toastStore.push({ variant: "error", message: "test" });
           expect(id).toBeGreaterThan(0);
           expect(get(toastStore)).toHaveLength(1);
           expect(get(toastStore)[0].variant).toBe("error");
         });

         it("UI-04: auto-dismiss after 5000 ms", () => {
           vi.useFakeTimers();
           toastStore.push({ variant: "error", message: "test" });
           expect(get(toastStore)).toHaveLength(1);
           vi.advanceTimersByTime(4999);
           expect(get(toastStore)).toHaveLength(1);
           vi.advanceTimersByTime(2);
           expect(get(toastStore)).toHaveLength(0);
           vi.useRealTimers();
         });

         it("UI-04: caps at 3 — 4th push drops the oldest", () => {
           toastStore.push({ variant: "error", message: "a" });
           toastStore.push({ variant: "error", message: "b" });
           toastStore.push({ variant: "error", message: "c" });
           toastStore.push({ variant: "error", message: "d" });
           const toasts = get(toastStore);
           expect(toasts).toHaveLength(3);
           expect(toasts.map((t) => t.message)).toEqual(["b", "c", "d"]);
         });

         it("UI-04: dismiss removes toast by id", () => {
           const id = toastStore.push({ variant: "error", message: "x" });
           toastStore.dismiss(id);
           expect(get(toastStore)).toHaveLength(0);
         });
       });
       ```
  </action>
  <verify>
    <automated>pnpm vitest run tests/vault.test.ts &amp;&amp; pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `src/types/errors.ts` contains `export type VaultErrorKind` AND all 8 kinds (`FileNotFound`, `PermissionDenied`, `DiskFull`, `IndexCorrupt`, `VaultUnavailable`, `MergeConflict`, `InvalidEncoding`, `Io`) AND `isVaultError` AND `vaultErrorCopy`
    - `src/types/vault.ts` contains `VaultInfo`, `VaultStats`, `RecentVault`, `VaultStatus`
    - `src/ipc/commands.ts` contains `openVault`, `getRecentVaults`, `getVaultStats`, `readFile`, `writeFile`, `pickVaultFolder` AND imports `invoke` from `@tauri-apps/api/core` AND imports `open` from `@tauri-apps/plugin-dialog`
    - `grep -c "invoke<" src/ipc/commands.ts` returns at least 5
    - `src/store/vaultStore.ts` contains `import { writable }` and does NOT contain `$state` (RC-01 enforcement)
    - `src/store/toastStore.ts` contains `const MAX_TOASTS = 3` AND `const AUTO_DISMISS_MS = 5000`
    - `src/store/editorStore.ts` contains `import { writable }` and does NOT contain `$state`
    - `src/store/progressStore.ts` contains `import { writable }`
    - `tests/vault.test.ts` does NOT contain `it.todo` anywhere
    - `pnpm vitest run tests/vault.test.ts` exits 0 with at least 9 passed
    - `pnpm typecheck` exits 0
  </acceptance_criteria>
  <done>Types, IPC, and four stores implemented with classic writable. Nine vault.test.ts assertions green. Typecheck passes under strict mode.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Toast component + ToastContainer + Toast.test.ts assertions</name>
  <files>
    src/components/Toast/Toast.svelte,
    src/components/Toast/ToastContainer.svelte,
    tests/Toast.test.ts
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Toast System" (position, anatomy, variants, behavior)
    - src/store/toastStore.ts (from Task 1)
    - src/styles/tailwind.css (CSS variables from Wave 0)
    - tests/Toast.test.ts (it.todo stubs)
  </read_first>
  <behavior>
    - Toast.svelte: takes `toast: Toast` prop and renders a card with variant-colored 4px left border, icon (✕/⚠/✓), message text, dismiss button (×)
    - Container subscribes to toastStore, renders each toast with `data-testid="toast"` and `data-variant={variant}`
    - Container positions bottom-right 16px with 8px gap
    - Dismiss button calls `toastStore.dismiss(id)`
    - Each toast has `role="status"` and `aria-live="polite"` for a11y
  </behavior>
  <action>
    1. **`src/components/Toast/Toast.svelte`:**
       ```svelte
       <script lang="ts">
         import type { Toast, ToastVariant } from "../../store/toastStore";
         import { toastStore } from "../../store/toastStore";

         let { toast }: { toast: Toast } = $props();

         const icon: Record<ToastVariant, string> = {
           error: "✕",
           conflict: "⚠",
           "clean-merge": "✓",
         };

         const borderVar: Record<ToastVariant, string> = {
           error: "var(--color-error)",
           conflict: "var(--color-warning)",
           "clean-merge": "var(--color-success)",
         };
       </script>

       <div
         class="vc-toast"
         data-testid="toast"
         data-variant={toast.variant}
         role="status"
         aria-live="polite"
         style:border-left-color={borderVar[toast.variant]}
       >
         <span class="vc-toast-icon" aria-hidden="true">{icon[toast.variant]}</span>
         <span class="vc-toast-message">{toast.message}</span>
         <button
           type="button"
           class="vc-toast-dismiss"
           aria-label="Dismiss notification"
           onclick={() => toastStore.dismiss(toast.id)}
         >×</button>
       </div>

       <style>
         .vc-toast {
           width: 320px;
           background: var(--color-surface);
           border: 1px solid var(--color-border);
           border-left-width: 4px;
           border-radius: 8px;
           padding: 12px;
           box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
           display: grid;
           grid-template-columns: auto 1fr auto;
           gap: 8px;
           align-items: center;
           color: var(--color-text);
           font-size: 14px;
           line-height: 1.5;
         }
         .vc-toast-icon { font-weight: 700; }
         .vc-toast-message { flex: 1; }
         .vc-toast-dismiss {
           background: none;
           border: none;
           font-size: 16px;
           color: var(--color-text-muted);
           cursor: pointer;
           padding: 0 4px;
         }
         .vc-toast-dismiss:hover { color: var(--color-text); }
       </style>
       ```

    2. **`src/components/Toast/ToastContainer.svelte`:**
       ```svelte
       <script lang="ts">
         import { toastStore } from "../../store/toastStore";
         import Toast from "./Toast.svelte";
       </script>

       <div class="vc-toast-container" data-testid="toast-container">
         {#each $toastStore as toast (toast.id)}
           <Toast {toast} />
         {/each}
       </div>

       <style>
         .vc-toast-container {
           position: fixed;
           bottom: 16px;
           right: 16px;
           display: flex;
           flex-direction: column;
           gap: 8px;
           z-index: 1000;
           pointer-events: none;
         }
         .vc-toast-container :global(.vc-toast) {
           pointer-events: auto;
         }
       </style>
       ```

    3. **`tests/Toast.test.ts`:** (upgrade stubs to real assertions)
       ```typescript
       import { describe, it, expect, beforeEach, vi } from "vitest";
       import { render, screen, fireEvent } from "@testing-library/svelte";
       import { get } from "svelte/store";
       import ToastContainer from "../src/components/Toast/ToastContainer.svelte";
       import { toastStore } from "../src/store/toastStore";

       beforeEach(() => {
         toastStore._reset();
       });

       describe("UI-04: Toast component variants", () => {
         it("UI-04: renders error variant with ✕ icon and data-variant=error", async () => {
           render(ToastContainer);
           toastStore.push({ variant: "error", message: "Vault not found." });
           const toast = await screen.findByTestId("toast");
           expect(toast.getAttribute("data-variant")).toBe("error");
           expect(toast.textContent).toContain("✕");
           expect(toast.textContent).toContain("Vault not found.");
         });

         it("UI-04: renders conflict variant with ⚠ icon", async () => {
           render(ToastContainer);
           toastStore.push({ variant: "conflict", message: "Conflict in note.md — local version kept." });
           const toast = await screen.findByTestId("toast");
           expect(toast.getAttribute("data-variant")).toBe("conflict");
           expect(toast.textContent).toContain("⚠");
         });

         it("UI-04: renders clean-merge variant with ✓ icon", async () => {
           render(ToastContainer);
           toastStore.push({ variant: "clean-merge", message: "External changes merged into note.md." });
           const toast = await screen.findByTestId("toast");
           expect(toast.getAttribute("data-variant")).toBe("clean-merge");
           expect(toast.textContent).toContain("✓");
         });

         it("UI-04: dismiss button removes the toast from the DOM", async () => {
           render(ToastContainer);
           toastStore.push({ variant: "error", message: "click me" });
           const dismiss = await screen.findByLabelText("Dismiss notification");
           await fireEvent.click(dismiss);
           expect(screen.queryByTestId("toast")).toBeNull();
         });

         it("UI-04: auto-dismiss after 5000 ms removes the toast", async () => {
           vi.useFakeTimers();
           render(ToastContainer);
           toastStore.push({ variant: "error", message: "fleeting" });
           expect(get(toastStore)).toHaveLength(1);
           vi.advanceTimersByTime(5001);
           expect(get(toastStore)).toHaveLength(0);
           vi.useRealTimers();
         });

         it("UI-04: stacking past 3 toasts drops the oldest from the DOM", async () => {
           render(ToastContainer);
           toastStore.push({ variant: "error", message: "a" });
           toastStore.push({ variant: "error", message: "b" });
           toastStore.push({ variant: "error", message: "c" });
           toastStore.push({ variant: "error", message: "d" });
           const toasts = await screen.findAllByTestId("toast");
           expect(toasts).toHaveLength(3);
           const texts = toasts.map((t) => t.textContent ?? "");
           expect(texts.some((t) => t.includes("a"))).toBe(false);
           expect(texts.some((t) => t.includes("d"))).toBe(true);
         });
       });
       ```
  </action>
  <verify>
    <automated>pnpm vitest run tests/Toast.test.ts &amp;&amp; pnpm typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `src/components/Toast/Toast.svelte` contains `data-variant={toast.variant}` AND `border-left-color` AND all three icons (`✕`, `⚠`, `✓`)
    - `src/components/Toast/Toast.svelte` contains `var(--color-error)` AND `var(--color-warning)` AND `var(--color-success)` AND `var(--color-surface)` AND `var(--color-border)`
    - `src/components/Toast/ToastContainer.svelte` contains `$toastStore` AND `position: fixed` AND `bottom: 16px` AND `right: 16px` AND `gap: 8px`
    - `tests/Toast.test.ts` does NOT contain `it.todo`
    - `pnpm vitest run tests/Toast.test.ts` exits 0 with at least 6 passed
    - `pnpm typecheck` exits 0
  </acceptance_criteria>
  <done>Toast.svelte renders three variants with correct CSS variables and icons. Six Toast.test.ts assertions green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: WelcomeScreen + App.svelte auto-load flow + WelcomeScreen.test.ts assertions</name>
  <files>
    src/components/Welcome/WelcomeScreen.svelte,
    src/components/Welcome/RecentVaultRow.svelte,
    src/App.svelte,
    tests/WelcomeScreen.test.ts
  </files>
  <read_first>
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Welcome Screen", "Copywriting Contract", "Interaction States", "Color" (all values)
    - .planning/phases/01-skeleton/01-CONTEXT.md D-14 (flat file list placeholder), D-15 (auto-load does NOT reopen last-edited file)
    - src/store/vaultStore.ts, src/store/toastStore.ts, src/ipc/commands.ts (from Task 1)
    - src/components/Toast/ToastContainer.svelte (from Task 2)
    - tests/WelcomeScreen.test.ts (it.todo stubs)
  </read_first>
  <behavior>
    - WelcomeScreen renders centered card with heading "VaultCore", tagline "A faster Markdown workspace for large vaults.", "Open vault" CTA, divider, "RECENT VAULTS" label, recent list (empty state if none)
    - Clicking "Open vault" → calls `pickVaultFolder()` → if a path is returned, calls `openVault(path)` → on success, `vaultStore.setReady(...)`; on failure, `toastStore.push({ variant: "error", message: vaultErrorCopy(err) })`
    - Clicking a recent vault row → same flow with `openVault(row.path)`
    - WelcomeScreen accepts a `recent: RecentVault[]` prop so tests can inject directly
    - On App.svelte mount: call `getRecentVaults()`, if first entry's path exists, call `openVault(path)`; on failure set VaultUnavailable error + toast + leave WelcomeScreen visible (VAULT-05 path)
    - App.svelte renders `<WelcomeScreen />` when `status === 'idle' || 'error'`, a placeholder `<VaultViewStub />` (just a div with `data-testid="vault-view"`) when `status === 'ready'`, and always renders `<ToastContainer />`
    - The placeholder VaultViewStub will be replaced in plan 01-04 with the real file list + editor
  </behavior>
  <action>
    1. **`src/components/Welcome/RecentVaultRow.svelte`:**
       ```svelte
       <script lang="ts">
         import type { RecentVault } from "../../types/vault";

         let {
           vault,
           onOpen,
         }: { vault: RecentVault; onOpen: (path: string) => void } = $props();

         function formatTimestamp(iso: string): string {
           // Plan 01-01 uses epoch-seconds strings; Phase 5 will swap for real ISO.
           // Display as-is for now.
           return iso;
         }
       </script>

       <button
         type="button"
         class="vc-recent-row"
         data-testid="recent-row"
         onclick={() => onOpen(vault.path)}
       >
         <span class="vc-recent-path" title={vault.path}>{vault.path}</span>
         <span class="vc-recent-ts">{formatTimestamp(vault.last_opened)}</span>
       </button>

       <style>
         .vc-recent-row {
           display: grid;
           grid-template-columns: 1fr auto;
           align-items: center;
           gap: 8px;
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
         }
         .vc-recent-row:hover {
           background: var(--color-accent-bg);
           border-left-color: var(--color-accent);
         }
         .vc-recent-path {
           direction: rtl;
           text-align: left;
           overflow: hidden;
           text-overflow: ellipsis;
           white-space: nowrap;
         }
         .vc-recent-ts {
           font-size: 12px;
           color: var(--color-text-muted);
         }
       </style>
       ```

    2. **`src/components/Welcome/WelcomeScreen.svelte`:**
       ```svelte
       <script lang="ts">
         import type { RecentVault } from "../../types/vault";
         import RecentVaultRow from "./RecentVaultRow.svelte";

         let {
           recent = [],
           onOpenVault,
           onPickVault,
         }: {
           recent?: RecentVault[];
           onOpenVault: (path: string) => void;
           onPickVault: () => void;
         } = $props();
       </script>

       <main class="vc-welcome" data-testid="welcome-screen">
         <div class="vc-welcome-card">
           <h1 class="vc-welcome-heading">VaultCore</h1>
           <p class="vc-welcome-tagline">A faster Markdown workspace for large vaults.</p>

           <button type="button" class="vc-cta" data-testid="open-vault-button" onclick={onPickVault}>
             Open vault
           </button>

           <hr class="vc-divider" />

           <h2 class="vc-recent-label">RECENT VAULTS</h2>

           {#if recent.length === 0}
             <div class="vc-empty" data-testid="recent-empty">
               <p class="vc-empty-heading">No recent vaults</p>
               <p class="vc-empty-body">Open a folder to get started.</p>
             </div>
           {:else}
             <div class="vc-recent-list" data-testid="recent-list">
               {#each recent as vault (vault.path)}
                 <RecentVaultRow {vault} onOpen={onOpenVault} />
               {/each}
             </div>
           {/if}
         </div>
       </main>

       <style>
         .vc-welcome {
           min-height: 100vh;
           display: flex;
           align-items: center;
           justify-content: center;
           padding: 64px 16px;
           background: var(--color-bg);
         }
         .vc-welcome-card {
           width: 100%;
           max-width: 480px;
           padding: 48px 32px;
           background: var(--color-surface);
           border: 1px solid var(--color-border);
           border-radius: 8px;
           box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
         }
         .vc-welcome-heading {
           margin: 0 0 8px 0;
           font-size: 20px;
           font-weight: 700;
           line-height: 1.2;
           color: var(--color-text);
         }
         .vc-welcome-tagline {
           margin: 0 0 32px 0;
           font-size: 14px;
           font-weight: 400;
           color: var(--color-text-muted);
         }
         .vc-cta {
           display: block;
           width: 100%;
           padding: 8px 16px;
           background: var(--color-accent);
           color: #ffffff;
           border: none;
           border-radius: 6px;
           font-size: 14px;
           font-weight: 400;
           font-family: var(--vc-font-body);
           cursor: pointer;
         }
         .vc-cta:hover { filter: brightness(0.9); }
         .vc-cta:active { filter: brightness(0.8); }
         .vc-cta:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
         .vc-divider {
           border: none;
           border-top: 1px solid var(--color-border);
           margin: 24px 0;
         }
         .vc-recent-label {
           margin: 0 0 8px 0;
           font-size: 12px;
           font-weight: 400;
           letter-spacing: 0.08em;
           text-transform: uppercase;
           color: var(--color-text-muted);
         }
         .vc-empty {
           padding: 8px 16px;
           color: var(--color-text-muted);
         }
         .vc-empty-heading { margin: 0 0 4px 0; font-size: 14px; }
         .vc-empty-body { margin: 0; font-size: 14px; }
         .vc-recent-list { display: flex; flex-direction: column; }
       </style>
       ```

    3. **`src/App.svelte`** — auto-load flow + conditional render:
       ```svelte
       <script lang="ts">
         import { onMount } from "svelte";
         import { vaultStore } from "./store/vaultStore";
         import { toastStore } from "./store/toastStore";
         import {
           getRecentVaults,
           openVault,
           pickVaultFolder,
         } from "./ipc/commands";
         import { vaultErrorCopy, isVaultError } from "./types/errors";
         import type { RecentVault } from "./types/vault";
         import WelcomeScreen from "./components/Welcome/WelcomeScreen.svelte";
         import ToastContainer from "./components/Toast/ToastContainer.svelte";

         let recent: RecentVault[] = $state([]);

         async function loadVault(path: string): Promise<void> {
           vaultStore.setOpening(path);
           try {
             const info = await openVault(path);
             // File list will be populated by plan 01-04 via the progress event flow.
             // For now, set ready with empty list; the Wave 4 implementation replaces this.
             vaultStore.setReady({
               currentPath: info.path,
               fileList: [],
               fileCount: info.file_count,
             });
             // Refresh recent list after successful open
             recent = await getRecentVaults();
           } catch (err) {
             const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
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
             const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
             toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
           }
         }

         function handleOpenRecent(path: string): void {
           void loadVault(path);
         }

         onMount(async () => {
           // VAULT-03: auto-load last reachable vault on startup
           try {
             recent = await getRecentVaults();
             const last = recent[0];
             if (last) {
               await loadVault(last.path);
             }
           } catch (err) {
             // VAULT-05: last vault unreachable → stay on Welcome + toast
             const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
             toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
           }
         });
       </script>

       {#if $vaultStore.status === "ready"}
         <!-- Placeholder VaultView — replaced by plan 01-04 -->
         <main data-testid="vault-view" class="vc-vault-view">
           <p>Vault opened: {$vaultStore.currentPath}</p>
           <p>{$vaultStore.fileCount} file(s)</p>
         </main>
       {:else}
         <WelcomeScreen {recent} onOpenVault={handleOpenRecent} onPickVault={handlePickVault} />
       {/if}

       <ToastContainer />

       <style>
         .vc-vault-view {
           padding: 32px;
           color: var(--color-text);
         }
       </style>
       ```

    4. **`tests/WelcomeScreen.test.ts`** — render the component directly with stub props (App.svelte on-mount flow is integration-tested in plan 01-04):
       ```typescript
       import { describe, it, expect, vi } from "vitest";
       import { render, screen, fireEvent } from "@testing-library/svelte";
       import WelcomeScreen from "../src/components/Welcome/WelcomeScreen.svelte";

       describe("VAULT-04: Welcome screen render", () => {
         it("VAULT-04: renders VaultCore heading and Open vault button", () => {
           render(WelcomeScreen, {
             recent: [],
             onOpenVault: () => {},
             onPickVault: () => {},
           });
           expect(screen.getByRole("heading", { name: "VaultCore" })).toBeInTheDocument();
           expect(screen.getByTestId("open-vault-button")).toHaveTextContent("Open vault");
         });

         it("VAULT-04: renders tagline", () => {
           render(WelcomeScreen, {
             recent: [],
             onOpenVault: () => {},
             onPickVault: () => {},
           });
           expect(
             screen.getByText("A faster Markdown workspace for large vaults.")
           ).toBeInTheDocument();
         });

         it("VAULT-04: renders empty state when recent list is empty", () => {
           render(WelcomeScreen, {
             recent: [],
             onOpenVault: () => {},
             onPickVault: () => {},
           });
           const empty = screen.getByTestId("recent-empty");
           expect(empty.textContent).toContain("No recent vaults");
           expect(empty.textContent).toContain("Open a folder to get started.");
         });

         it("VAULT-04: renders recent vault rows when recent list has entries", () => {
           render(WelcomeScreen, {
             recent: [
               { path: "/Users/alice/notes", last_opened: "100Z" },
               { path: "/Users/alice/work", last_opened: "200Z" },
             ],
             onOpenVault: () => {},
             onPickVault: () => {},
           });
           const rows = screen.getAllByTestId("recent-row");
           expect(rows).toHaveLength(2);
           expect(rows[0].textContent).toContain("/Users/alice/notes");
         });

         it("VAULT-01: clicking Open vault button invokes onPickVault handler", async () => {
           const handler = vi.fn();
           render(WelcomeScreen, {
             recent: [],
             onOpenVault: () => {},
             onPickVault: handler,
           });
           await fireEvent.click(screen.getByTestId("open-vault-button"));
           expect(handler).toHaveBeenCalledOnce();
         });

         it("VAULT-04: clicking a recent row invokes onOpenVault with that path", async () => {
           const handler = vi.fn();
           render(WelcomeScreen, {
             recent: [{ path: "/a/b", last_opened: "1Z" }],
             onOpenVault: handler,
             onPickVault: () => {},
           });
           await fireEvent.click(screen.getByTestId("recent-row"));
           expect(handler).toHaveBeenCalledWith("/a/b");
         });
       });
       ```
  </action>
  <verify>
    <automated>pnpm vitest run tests/WelcomeScreen.test.ts &amp;&amp; pnpm typecheck &amp;&amp; pnpm build</automated>
  </verify>
  <acceptance_criteria>
    - `src/components/Welcome/WelcomeScreen.svelte` contains `VaultCore` heading AND `A faster Markdown workspace for large vaults.` AND `Open vault` AND `RECENT VAULTS` AND `No recent vaults` AND `Open a folder to get started.`
    - `src/components/Welcome/WelcomeScreen.svelte` contains all of: `var(--color-bg)`, `var(--color-surface)`, `var(--color-border)`, `var(--color-text)`, `var(--color-text-muted)`, `var(--color-accent)`, `max-width: 480px`, `border-radius: 8px`
    - `src/components/Welcome/RecentVaultRow.svelte` contains `direction: rtl` (middle-truncate per UI-SPEC)
    - `src/App.svelte` contains `onMount` AND `getRecentVaults` AND `openVault` AND `vaultStore.setOpening` AND `vaultStore.setReady` AND `vaultStore.setError` AND `data-testid="vault-view"` AND `<ToastContainer />`
    - `src/App.svelte` does NOT reference `invoke(` directly — all IPC goes through `src/ipc/commands.ts`
    - `tests/WelcomeScreen.test.ts` does NOT contain `it.todo`
    - `pnpm vitest run tests/WelcomeScreen.test.ts` exits 0 with at least 6 passed
    - `pnpm typecheck` exits 0
    - `pnpm build` exits 0
    - `grep -r "invoke(" src/components/ src/App.svelte` returns 0 lines (only `src/ipc/commands.ts` may call invoke)
  </acceptance_criteria>
  <done>Welcome screen renders UI-SPEC layout, auto-load flow wired, VAULT-05 fallback in place, six component assertions green, full frontend builds.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User click → `pickVaultFolder` → native OS dialog | User input authoritative; OS chrome outside VaultCore's trust |
| `invoke` call → Rust command | Typed wrapper layer between JS and Rust |
| Error object from Rust → UI | `VaultError` shape must survive the IPC boundary unmangled |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-01 | Tampering (frontend bypass) | `src/App.svelte`, `src/components/*` | mitigate | Task 1/3: ALL IPC goes through `src/ipc/commands.ts`. Components never call `invoke` directly. Grep check in acceptance criteria confirms no `invoke(` in `src/components/` or `src/App.svelte`. This ensures the T-02 vault-scope guard (enforced in Wave 1 `read_file`/`write_file`) can't be bypassed by a component that forgets to call the wrapper. |
| T-02-02 | Spoofing (fake error shapes) | `normalizeError` in `src/ipc/commands.ts` | mitigate | Task 1: `isVaultError` type guard validates shape before the error propagates. Unknown errors are coerced to `Io` kind, preventing UI logic from branching on a malformed `kind` string. |
| T-02-03 | Information Disclosure (path in toast) | `vaultErrorCopy` | mitigate | Task 1: User-facing copy comes from a static map that does NOT interpolate raw filesystem paths (except `MergeConflict` which uses `data` — the path is already canonicalized vault-internal). Prevents leaking `/etc/...` style absolute paths in toast text. |
| T-06 | Zero-network guarantee | `src/components/Welcome/WelcomeScreen.svelte` | mitigate | Task 3: Font stack is the system-ui stack per UI-SPEC — NO Google Fonts link. No `<link rel="stylesheet" href="http...">`. No `<script src="http...">`. Grep check in verification. |
| T-02-E | Elevation (store tampering) | `toastStore._reset` | accept | Exposed only for tests. Shipped in prod, but it only clears local state — cannot grant privileges or touch the filesystem. Accepted risk. Plan 01-05 or a later polish task may move this to a test-only export. |
</threat_model>

<verification>
- `pnpm vitest run` exits 0 with at least 21 passed tests (9 vault + 6 Toast + 6 WelcomeScreen)
- `pnpm typecheck` exits 0
- `pnpm build` exits 0
- `grep -rE "(cdn\.|googleapis\.com|http://|https://)" src/components/ src/App.svelte` returns nothing (T-06 / SEC-01)
- `grep -rE "invoke\(" src/components/ src/App.svelte` returns nothing (T-02-01)
- `grep -rE "\\\$state\\(" src/store/` returns nothing (RC-01 / D-06 compliance)
</verification>

<success_criteria>
1. Typed IPC layer wraps all five backend commands
2. Four stores implemented with classic `writable` (no `$state` class wrappers per RC-01)
3. Welcome screen matches UI-SPEC layout and copy
4. Toast component renders three variants with correct CSS variables and auto-dismiss behavior
5. Auto-load-last-vault flow works with VAULT-05 fallback to Welcome + toast
6. 21+ Vitest assertions green
7. SEC-01 / T-06 zero-network grep check passes
</success_criteria>

<output>
After completion, create `.planning/phases/01-skeleton/01-02-SUMMARY.md` per summary template.
</output>
