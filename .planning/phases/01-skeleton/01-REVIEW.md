---
phase: 01-skeleton
reviewed: 2026-04-11T00:00:00Z
depth: standard
files_reviewed: 49
files_reviewed_list:
  - index.html
  - package.json
  - src/App.svelte
  - src/components/Editor/autoSave.ts
  - src/components/Editor/CMEditor.svelte
  - src/components/Editor/extensions.ts
  - src/components/Editor/keymap.ts
  - src/components/Editor/theme.ts
  - src/components/Progress/ProgressBar.svelte
  - src/components/Toast/ToastContainer.svelte
  - src/components/Toast/Toast.svelte
  - src/components/Welcome/FileListRow.svelte
  - src/components/Welcome/RecentVaultRow.svelte
  - src/components/Welcome/VaultView.svelte
  - src/components/Welcome/WelcomeScreen.svelte
  - src/ipc/commands.ts
  - src/ipc/events.ts
  - src/main.ts
  - src/store/editorStore.ts
  - src/store/progressStore.ts
  - src/store/toastStore.ts
  - src/store/vaultStore.ts
  - src/styles/tailwind.css
  - src-tauri/build.rs
  - src-tauri/capabilities/default.json
  - src-tauri/Cargo.toml
  - src-tauri/src/commands/files.rs
  - src-tauri/src/commands/mod.rs
  - src-tauri/src/commands/vault.rs
  - src-tauri/src/error.rs
  - src-tauri/src/hash.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/main.rs
  - src-tauri/src/tests/error_serialize.rs
  - src-tauri/src/tests/files.rs
  - src-tauri/src/tests/mod.rs
  - src-tauri/src/tests/vault_stats.rs
  - src-tauri/tauri.conf.json
  - src/test/setup.ts
  - src/types/errors.ts
  - src/types/vault.ts
  - svelte.config.js
  - tests/autoSave.test.ts
  - tests/indexProgress.test.ts
  - tests/keymap.test.ts
  - tests/Toast.test.ts
  - tests/vault.test.ts
  - tests/WelcomeScreen.test.ts
  - tsconfig.json
  - vite.config.ts
  - vitest.config.ts
findings:
  critical: 1
  warning: 5
  info: 3
  total: 9
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-04-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 49
**Status:** issues_found

## Summary

Phase 1 skeleton is well-structured overall. The Tauri backend implements proper vault-scope guards (T-02), UTF-8 rejection (D-17), and path canonicalization (T-01). The frontend uses classic writable stores (D-06/RC-01) correctly, the CM6 extension list is explicit without basicSetup (RC-02), and auto-save uses a 2s fixed debounce as specified. IPC is centralized through `src/ipc/commands.ts`.

Key concerns: one critical security issue with the `Mutex::lock().unwrap()` pattern in the file commands (can panic and crash the Tauri process), a stale-closure bug in the auto-save extension, and a missing `exhaust` default branch in the error copy map.

## Critical Issues

### CR-01: Mutex::lock().unwrap() can panic under poison, crashing the entire app

**File:** `src-tauri/src/commands/files.rs:29`
**Issue:** `state.current_vault.lock().unwrap()` will panic if the Mutex is poisoned (e.g., a previous thread panicked while holding the lock). Since these are Tauri command handlers, a panic crashes the entire application process. The same pattern appears at line 85 of `files.rs` and lines 157 of `vault.rs`. In a desktop app where the user may have unsaved work, an unrecoverable crash violates the crash-recovery constraint (at most 2s of data loss is acceptable, but a full process crash loses all open editor state).
**Fix:** Replace `.unwrap()` with error handling. For example:
```rust
let guard = state.current_vault.lock().map_err(|_| VaultError::Io(
    std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned")
))?;
```
Apply this pattern at all three lock sites: `files.rs:29`, `files.rs:85`, and `vault.rs:157`. Also update the test `_impl` helpers in `tests/files.rs` (lines 163, 195) to match.

## Warnings

### WR-01: Auto-save closure captures stale `update.state` reference

**File:** `src/components/Editor/autoSave.ts:23-26`
**Issue:** The `setTimeout` callback captures `update.state` from the closure at the time the timer is scheduled. If additional document changes occur after the timer is set but before it fires (within the same debounce window where the timer is NOT reset -- e.g., a programmatic dispatch that does not trigger `updateListener`), `update.state.doc.toString()` returns the document state at scheduling time, not the current state. In practice this is low-risk for Phase 1 (user keystrokes always reset the timer), but it will become a real bug when programmatic updates are added in later phases.
**Fix:** Store a reference to the EditorView and read its current state in the callback:
```typescript
export function autoSaveExtension(
  onSave: (text: string) => void
): Extension {
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

### WR-02: vaultErrorCopy switch lacks exhaustive default, TypeScript may not catch new kinds

**File:** `src/types/errors.ts:39-57`
**Issue:** The `vaultErrorCopy` function has a `switch` on `err.kind` that covers all current variants but has no `default` branch. TypeScript's `noUncheckedIndexedAccess` is enabled but the function return type is `string` (not enforced as exhaustive). If a new variant is added to `VaultErrorKind` without updating this function, it will silently return `undefined` at runtime (the function falls through with no return). This is a correctness bug waiting to happen.
**Fix:** Add an exhaustive check:
```typescript
export function vaultErrorCopy(err: VaultError): string {
  switch (err.kind) {
    // ... existing cases ...
    default: {
      const _exhaustive: never = err.kind;
      return "An unexpected error occurred.";
    }
  }
}
```

### WR-03: open_vault walks the directory tree twice (count_md_files + collect_file_list)

**File:** `src-tauri/src/commands/vault.rs:166-169`
**Issue:** `open_vault` calls `count_md_files(&canonical)` then `collect_file_list(&canonical)`. Both perform a full recursive walkdir traversal. For the target 100k-note vault, this means two complete filesystem walks. The `total` count returned by `count_md_files` is used for progress events but could be derived from `file_list.len()` after the single `collect_file_list` call. This is not a performance review item per se, but it is a correctness concern: between the two walks, files could be added or removed, causing `total != file_list.len()` and the progress bar to show incorrect values (e.g., 99,999/100,000 or 100,001/100,000).
**Fix:** Remove the separate `count_md_files` call and derive `total` from the collected list:
```rust
let file_list = collect_file_list(&canonical);
let total = file_list.len();
```

### WR-04: CSP is explicitly set to null in tauri.conf.json

**File:** `src-tauri/tauri.conf.json:23`
**Issue:** `"csp": null` disables Content Security Policy entirely. While VaultCore has zero network calls by design (SEC-01), a null CSP means any XSS vulnerability in the webview would have unrestricted access -- inline scripts, eval, loading external resources. Even for a local-only app, a CSP that restricts to `'self'` and `'unsafe-inline'` (needed for Svelte styles) would provide defense-in-depth.
**Fix:** Set a restrictive CSP:
```json
"csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:"
```

### WR-05: Non-null assertion on getElementById in main.ts with no fallback

**File:** `src/main.ts:6`
**Issue:** `document.getElementById('app')!` uses a non-null assertion. If the `#app` element is missing (e.g., index.html is misconfigured), this will throw an opaque runtime error. While unlikely in practice, defensive handling costs nothing.
**Fix:**
```typescript
const target = document.getElementById('app');
if (!target) throw new Error('Root element #app not found in index.html');
const app = mount(App, { target });
```

## Info

### IN-01: Hardcoded color value in theme for monospace code background

**File:** `src/components/Editor/theme.ts:47`
**Issue:** The `.tok-monospace` background uses a hardcoded hex color `#F3F4F6` while all other colors in the codebase use CSS custom properties (e.g., `var(--color-border)`). This will not adapt to dark mode when it is added.
**Fix:** Replace with a CSS variable: `backgroundColor: "var(--color-border)"` or introduce a dedicated `--color-code-bg` variable.

### IN-02: Unused `codemirror` top-level package dependency

**File:** `package.json:42`
**Issue:** The `codemirror` package (line 42) is a convenience meta-package that re-exports `@codemirror/*` sub-packages. Since the codebase imports directly from `@codemirror/view`, `@codemirror/state`, etc., the top-level `codemirror` package is unused. It adds unnecessary weight to `node_modules`.
**Fix:** Remove `"codemirror": "^6.0.2"` from dependencies.

### IN-03: Test file duplicates command logic instead of extracting shared helpers

**File:** `src-tauri/src/tests/files.rs:150-213`
**Issue:** The `_impl` helpers in the test file duplicate the body of `read_file` and `write_file` from `commands/files.rs`. The comment at line 152 acknowledges this and warns the two must stay in sync. This is a maintenance risk -- if someone modifies the command without updating the test helper, the tests pass but the production code has a different (potentially broken) behavior. This is noted as intentional due to `tauri::State` limitations, but it is worth tracking as tech debt.
**Fix:** No immediate code change needed, but consider extracting the core logic into free functions that both the command and the test call, passing `&VaultState` directly rather than `tauri::State`.

---

_Reviewed: 2026-04-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
