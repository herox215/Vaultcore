---
phase: 01-skeleton
fixed_at: 2026-04-12T06:32:40Z
review_path: .planning/phases/01-skeleton/01-REVIEW.md
iteration: 2
findings_in_scope: 9
fixed: 8
skipped: 1
status: partial
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-04-12T06:32:40Z
**Source review:** .planning/phases/01-skeleton/01-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 9
- Fixed: 8 (6 in iteration 1 + 2 in iteration 2)
- Skipped: 1

## Fixed Issues (Iteration 1)

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

## Fixed Issues (Iteration 2)

### IN-01: Hardcoded color value in theme for monospace code background

**Files modified:** `src/components/Editor/theme.ts`, `src/styles/tailwind.css`
**Commit:** 9adc08f
**Applied fix:** Introduced `--color-code-bg: #F3F4F6` CSS custom property in `tailwind.css` and replaced the hardcoded `#F3F4F6` hex value in `theme.ts` with `var(--color-code-bg)`. This makes the inline code background dark-mode-ready while preserving the current appearance.

### IN-02: Unused `codemirror` top-level package dependency

**Files modified:** `package.json`
**Commit:** e0fbae4
**Applied fix:** Removed `"codemirror": "^6.0.2"` from the dependencies section. The codebase imports directly from `@codemirror/*` sub-packages, making the meta-package unnecessary.

## Skipped Issues

### IN-03: Test file duplicates command logic instead of extracting shared helpers

**File:** `src-tauri/src/tests/files.rs:150-213`
**Reason:** The review explicitly states "No immediate code change needed" and recommends tracking as tech debt. The duplication is intentional due to `tauri::State` limitations -- extracting shared helpers requires a design change (free functions accepting `&VaultState`) that goes beyond a mechanical fix.
**Original issue:** The `_impl` helpers in the test file duplicate the body of `read_file` and `write_file` from `commands/files.rs`, creating a maintenance risk if one side is updated without the other.

---

_Fixed: 2026-04-12T06:32:40Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
