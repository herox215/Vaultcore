---
phase: 01-skeleton
fixed_at: 2026-04-11T00:00:00Z
review_path: .planning/phases/01-skeleton/01-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-04-11T00:00:00Z
**Source review:** .planning/phases/01-skeleton/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: Mutex::lock().unwrap() can panic under poison, crashing the entire app

**Files modified:** `src-tauri/src/commands/files.rs`, `src-tauri/src/commands/vault.rs`, `src-tauri/src/tests/files.rs`
**Commit:** a4bf091
**Applied fix:** Replaced `.lock().unwrap()` with `.lock().map_err(|_| VaultError::Io(...))` at all 5 lock sites: `files.rs` ensure_inside_vault (line 29), `files.rs` write_file (line 85), `vault.rs` open_vault (line 157), and both `_impl` test helpers in `tests/files.rs` (lines 163 and 195). Poisoned mutex now returns an Io error instead of panicking the Tauri process.

### WR-01: Auto-save closure captures stale `update.state` reference

**Files modified:** `src/components/Editor/autoSave.ts`
**Commit:** a763649
**Applied fix:** Captured `update.view` into a `const view` before the `setTimeout` call, then read `view.state.doc.toString()` inside the callback. This ensures the callback always reads the EditorView's current state at fire time, not the state at scheduling time.

### WR-02: vaultErrorCopy switch lacks exhaustive default

**Files modified:** `src/types/errors.ts`
**Commit:** d346bd3
**Applied fix:** Added a `default` branch with `const _exhaustive: never = err.kind` to enforce compile-time exhaustiveness. Returns "An unexpected error occurred." as a runtime fallback.

### WR-03: open_vault walks the directory tree twice

**Files modified:** `src-tauri/src/commands/vault.rs`
**Commit:** bf4ad72
**Applied fix:** Removed the separate `count_md_files(&canonical)` call. Now `total` is derived from `file_list.len()` after the single `collect_file_list` pass. Eliminates the race condition where files could be added/removed between the two walks, causing progress bar count mismatch.

### WR-04: CSP is explicitly set to null in tauri.conf.json

**Files modified:** `src-tauri/tauri.conf.json`
**Commit:** 833026f
**Applied fix:** Replaced `"csp": null` with a restrictive policy: `"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:"`. This provides defense-in-depth against XSS while allowing Svelte inline styles and data: URIs for images.

### WR-05: Non-null assertion on getElementById in main.ts with no fallback

**Files modified:** `src/main.ts`
**Commit:** d5da84f
**Applied fix:** Replaced `document.getElementById('app')!` with a separate `const target` assignment followed by an explicit null check that throws a descriptive error message.

---

_Fixed: 2026-04-11T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
