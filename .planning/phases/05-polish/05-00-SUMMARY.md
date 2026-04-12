---
phase: 05-polish
plan: 00
subsystem: infra
tags: [rust, typescript, cargo, npm, serde_yml, codemirror, fontsource, direntry, theme]

# Dependency graph
requires:
  - phase: 04-links
    provides: DirEntry struct in tree.rs, CM6 editor with CSS variables, main.ts entry point

provides:
  - serde_yml 0.0.12 in Cargo.toml (maintained YAML crate for TAG-02)
  - "@codemirror/language-data 6.5.2 installed (EDIT-03 fenced code highlight)"
  - "@fontsource/inter, lora, jetbrains-mono, fira-code installed (UI-02 typography)"
  - "DirEntry.modified: Option<u64> and DirEntry.created: Option<u64> end-to-end (FILE-06 sort)"
  - "TypeScript DirEntry mirror: modified: number | null, created: number | null"
  - "markdownTheme fontSize reads var(--vc-font-size) instead of hardcoded 15px (UI-02 slider)"
  - "main.ts: 8 @fontsource CSS imports before Tailwind (cascade order correct)"
affects:
  - 05-01 (tags backend — uses serde_yml)
  - 05-02 (theme/typography — uses fontsource + CSS var)
  - 05-03 (file browser sort — uses DirEntry timestamps)
  - 05-04 (fenced code highlight — uses language-data)

# Tech tracking
tech-stack:
  added:
    - serde_yml 0.0.12 (Rust YAML crate, maintained fork of deprecated serde_yaml)
    - "@codemirror/language-data ^6.5.2"
    - "@fontsource/inter ^5.2.8"
    - "@fontsource/lora ^5.2.8"
    - "@fontsource/jetbrains-mono ^5.2.8"
    - "@fontsource/fira-code ^5.2.7"
  patterns:
    - "Double .ok() fallback for SystemTime ops that may fail on Linux ext4 (modified + created)"
    - "@fontsource CSS imports placed before Tailwind in main.ts entry point"
    - "CSS variable consumer wired before producer exists (browser falls back to inherited value)"

key-files:
  created: []
  modified:
    - src-tauri/Cargo.toml (serde_yml added)
    - src-tauri/Cargo.lock (serde_yml + libyml + ryu locked)
    - package.json (5 new npm packages)
    - pnpm-lock.yaml (lockfile updated)
    - src-tauri/src/commands/tree.rs (DirEntry struct + UNIX_EPOCH import + timestamp computation)
    - src-tauri/src/tests/tree.rs (3 new TDD tests: modified ±5s, created no-panic, serde snake_case)
    - src/types/tree.ts (modified: number | null, created: number | null)
    - src/components/Editor/theme.ts (fontSize: "var(--vc-font-size)")
    - src/main.ts (8 @fontsource imports prepended before tailwind.css)

key-decisions:
  - "Used pnpm (not npm) for install — project has pnpm-lock.yaml; npm errored with peer-dep conflict"
  - "serde_yml 0.0.12 chosen over deprecated serde_yaml per RESEARCH Pitfall 1"
  - "DirEntry timestamp fields use Option<u64> (UNIX seconds) with double .ok() to avoid panics on Linux ext4 and pre-epoch clocks"
  - "No serde rename_all=camelCase added to DirEntry — snake_case preserved for backward compat with existing frontend reads (is_dir, is_md, is_symlink)"
  - "var(--vc-font-size) consumer added before producer (Plan 02 adds --vc-font-size to :root) — browser falls back to inherited 14px without visual regression"

requirements-completed: [FILE-06, UI-02]

# Metrics
duration: 18min
completed: 2026-04-12
---

# Phase 5 Plan 00: Wave 0 Infrastructure Summary

**serde_yml, fontsource, and @codemirror/language-data installed; DirEntry extended with UNIX timestamp fields end-to-end (Rust + TS + 3 TDD tests); markdownTheme reads CSS variable for font size**

## Performance

- **Duration:** 18 min
- **Started:** 2026-04-12T20:19:53Z
- **Completed:** 2026-04-12T20:37:59Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- All Wave 1+ dependency prerequisites satisfied: serde_yml, @codemirror/language-data, and four @fontsource packages installed via pnpm
- DirEntry extended end-to-end: Rust struct gains `modified: Option<u64>` and `created: Option<u64>` populated from filesystem metadata without panicking on Linux ext4; TypeScript mirror updated to `number | null`
- Three TDD tests added (RED → GREEN) covering modified within ±5s of now, created never panics, and serde emits snake_case keys
- `markdownTheme.fontSize` changed from hardcoded `"15px"` to `"var(--vc-font-size)"` so Plan 02's font-size slider has observable effect
- Eight `@fontsource` CSS imports prepended before `tailwind.css` in `main.ts` preserving correct cascade order

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Cargo + npm dependencies** - `bc05c20` (chore)
2. **Task 2: Extend DirEntry with modified + created timestamps** - `4f6bb4c` (feat, TDD)
3. **Task 3: Wire theme.ts to --vc-font-size and prepend @fontsource imports** - `415cfb1` (feat)

## Files Created/Modified

- `src-tauri/Cargo.toml` - Added serde_yml = "0.0.12"
- `src-tauri/Cargo.lock` - Locked serde_yml 0.0.12 + libyml 0.0.5 + ryu 1.0.23
- `package.json` - Added @codemirror/language-data and four @fontsource packages
- `pnpm-lock.yaml` - Updated lockfile (pnpm install)
- `src-tauri/src/commands/tree.rs` - UNIX_EPOCH import; DirEntry fields modified+created; timestamp computation in list_directory_impl
- `src-tauri/src/tests/tree.rs` - 3 new TDD tests for timestamp behavior
- `src/types/tree.ts` - TypeScript mirror updated with modified: number | null, created: number | null
- `src/components/Editor/theme.ts` - fontSize changed from "15px" to "var(--vc-font-size)"
- `src/main.ts` - 8 @fontsource CSS imports prepended before tailwind.css

## Decisions Made

- **pnpm over npm:** Project has pnpm-lock.yaml; npm errored with a peer-dep conflict (`knip ^5.85.0` vs `typescript@6.0.2`). Used `pnpm install` which resolved cleanly in 3s.
- **serde_yml 0.0.12:** Used maintained fork instead of deprecated serde_yaml per RESEARCH Pitfall 1.
- **Double .ok() for timestamps:** `metadata().modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs())` — both `.ok()` calls needed: `created()` returns Err on Linux ext4, `duration_since()` returns Err on pre-epoch clocks.
- **No rename_all=camelCase:** Existing frontend code reads `is_dir`, `is_md`, `is_symlink` as snake_case; adding camelCase rename would break those reads.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used pnpm instead of npm for package installation**
- **Found during:** Task 1 (Add Cargo + npm dependencies)
- **Issue:** npm install failed with peer-dependency conflict (`knip ^5.85.0` incompatible with `typescript@6.0.2`); project has `pnpm-lock.yaml` indicating pnpm is the project package manager
- **Fix:** Ran `pnpm install` instead of `npm install`; installed cleanly in 3.1s
- **Files modified:** pnpm-lock.yaml (updated automatically)
- **Verification:** All 5 new packages appeared in node_modules; `pnpm install` exit 0
- **Committed in:** bc05c20 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — wrong package manager)
**Impact on plan:** Fix was trivial and correct. pnpm is the project's package manager. No scope creep.

## Issues Encountered

- Pre-existing `tsc --noEmit` errors in `src/store/tabStore.ts` and `src/store/tabStore.test.ts` (string | undefined vs string | null type mismatch). Confirmed pre-existing via git stash check. Logged to deferred-items.md. Not introduced by this plan.
- Pre-existing clippy warnings in vault.rs, watcher.rs, indexer/, lib.rs (io_other_error, unnecessary_map_or, collapsible_if, derivable_impls). Logged to deferred-items.md. No new warnings from our tree.rs changes.

## Known Stubs

None — this plan adds dependencies and extends data structures only; no UI components with placeholder data.

## Next Phase Readiness

All Wave 1+ plans can now proceed:
- Plan 01 (Tags backend): serde_yml available for YAML frontmatter parsing
- Plan 02 (Theme/Typography): @fontsource installed, theme.ts reads CSS variable, main.ts import order correct
- Plan 03 (File browser sort/persist): DirEntry.modified and .created available in both Rust and TypeScript
- Plan 04 (Fenced code highlight): @codemirror/language-data installed

No blockers for downstream plans. Pure infrastructure — no user-facing UI change shipped.

---
*Phase: 05-polish*
*Completed: 2026-04-12*
