---
phase: 01-skeleton
plan: 01
subsystem: backend
tags: [rust, tauri, serde, thiserror, walkdir, sha2, ipc, error-handling, filesystem]

# Dependency graph
requires:
  - phase: 01-00-scaffold-test-infra
    provides: Rust module tree, Cargo.toml dep set, 14 #[ignore]d cargo test stubs, placeholder VaultError
provides:
  - Full VaultError enum (spec §5) with `{ kind, message, data }` serde IPC shape
  - commands/vault.rs — open_vault, get_recent_vaults, get_vault_stats
  - commands/files.rs — read_file (D-17 UTF-8 guard), write_file (T-02 vault-scope guard, SHA-256 return)
  - hash.rs — SHA-256 content hasher (EDIT-10 groundwork)
  - VaultState (Mutex<Option<PathBuf>>) shared Tauri state for vault-scope enforcement
  - recent-vaults.json JSON persistence with FIFO-10 dedupe + eviction (D-23)
  - FsExt::allow_directory runtime scope expansion wired into open_vault (RESEARCH §1.5 / §8 Risk 1)
  - Hand-rolled ISO-8601 UTC formatter (Howard Hinnant civil_from_days, std-only)
  - 26 passing cargo unit tests (was 0 passed / 14 ignored in 01-00)
affects: [01-02-frontend-welcome, 01-03-editor-autosave, 01-04-progress-filelist-wireup, all future phases consuming the IPC surface]

# Tech tracking
tech-stack:
  added:
    - tempfile 3 (dev-dependency only) — tempdir-based vault fixtures for unit tests
  patterns:
    - "Manual serde::Serialize for VaultError produces stable `{ kind, message, data }` IPC contract independent of thiserror's Display formatting"
    - "VaultState as tauri::State<VaultState> with Mutex<Option<PathBuf>> — single source of truth for the currently-open vault, no global statics"
    - "Vault-scope guard pattern: canonicalize target then `canonical.starts_with(vault)` before any fs touch (read_file + write_file)"
    - "Write-path canonicalization: canonicalize the *parent* (not the file) since the file may not exist yet, then join file_name back"
    - "tauri::command bodies duplicated into `_impl` helpers in tests because tauri::State cannot be constructed outside a running Tauri app — helper bodies mirror command bodies and must stay in lockstep"
    - "ISO-8601 via Howard Hinnant civil_from_days: ~15 lines std-only, no chrono/time dep (D-19 compliance)"
    - "recent-vaults.json tolerates malformed files at read (unwrap_or_default) — next successful push overwrites; no crash on first run"

key-files:
  created:
    - src-tauri/src/hash.rs
    - src-tauri/src/tests/files.rs
    - .planning/phases/01-skeleton/01-01-backend-spine-SUMMARY.md
  modified:
    - src-tauri/src/error.rs  # Wave 0 Placeholder → full 8-variant enum with manual serde::Serialize
    - src-tauri/src/commands/vault.rs  # empty stub → 3 commands + recent-vaults persistence + ISO-8601 formatter
    - src-tauri/src/commands/files.rs  # empty stub → read_file + write_file with guards
    - src-tauri/src/lib.rs  # + hash module, + VaultState, + invoke_handler! with all 5 commands
    - src-tauri/src/tests/mod.rs  # + mod files;
    - src-tauri/src/tests/error_serialize.rs  # 8 #[ignore]s removed, full serde assertions added
    - src-tauri/src/tests/vault_stats.rs  # 6 #[ignore]s removed + ISO/RecentVault pin tests
    - src-tauri/Cargo.toml  # + [dev-dependencies] tempfile = "3"
    - src-tauri/Cargo.lock  # resolver refresh after tempfile add

key-decisions:
  - "Hand-rolled ISO-8601 formatter over chrono/time dep — D-19 forbids both; Howard Hinnant civil_from_days algo is ~15 lines of pure std"
  - "Keep `RFC 3339 URL` comment in vault.rs despite zero-network grep — the URL is prose documentation, not a runtime call"
  - "_impl helper duplication in tests/files.rs rather than refactor-to-shared-module — tauri::State is not constructible in unit context, and refactoring for tests now would spread the real command body across two files forever"
  - "write_file canonicalizes parent, not target (target may not exist yet), then joins file_name — identical effective guard, correct for both create and overwrite cases"
  - "read_file: Err from canonicalize with ErrorKind::NotFound maps to FileNotFound (not VaultUnavailable) so the frontend can distinguish a missing note from a missing vault"

patterns-established:
  - "Every #[tauri::command] returns `Result<T, VaultError>` and every error path explicitly maps std::io::ErrorKind variants to VaultError variants — no blanket Io catch-all at the command boundary"
  - "fs_scope() runtime expansion is tied to canonicalized paths only (never the raw user input) — T-01 + T-01-01-E defense in depth"
  - "Cargo test count is the progress gauge: 14 ignored (01-00) → 26 passing (01-01). Wave-gate pattern flips ignores to assertions rather than adding net-new tests"

requirements-completed: [ERR-01, VAULT-02, VAULT-04, VAULT-05, VAULT-06]
# Note: VAULT-01 (native folder picker) is a frontend concern in plan 01-02; this plan ships
# its Rust-side sink (open_vault) but not the UI that triggers it.

# Metrics
duration: ~25 min
completed: 2026-04-11
---

# Phase 01 Plan 01: Backend Spine Summary

**Full VaultError enum with `{ kind, message, data }` IPC shape, three vault commands with canonicalize + FsExt runtime scope expansion, two file commands with D-17 UTF-8 guard and T-02 vault-scope guard, SHA-256 hash helper, and 26 cargo tests green (was 14 ignored).**

## Performance

- **Duration:** ~25 min (all tasks sequential in single executor run)
- **Started:** 2026-04-11T20:40:00Z (post-01-00 resume)
- **Completed:** 2026-04-11T21:05:00Z
- **Tasks:** 3 (all `type="auto" tdd="true"`)
- **Files created:** 3 (hash.rs, tests/files.rs, this SUMMARY.md)
- **Files modified:** 9 (error.rs, vault.rs, files.rs, lib.rs, tests/mod.rs, tests/error_serialize.rs, tests/vault_stats.rs, Cargo.toml, Cargo.lock)

## Accomplishments

- **Full VaultError enum ships.** All 8 spec §5 variants (`FileNotFound`, `PermissionDenied`, `DiskFull`, `IndexCorrupt`, `VaultUnavailable`, `MergeConflict`, `InvalidEncoding`, `Io`) are present with a hand-written `serde::Serialize` impl that produces the stable `{ kind, message, data }` contract every Wave 2+ frontend plan will consume. 8/8 ERR-01 serde tests pass with explicit assertions on kind + message + data fields.
- **Vault commands compile and pass tests end-to-end.** `open_vault` canonicalizes the user path (T-01), grants Tauri plugin-fs runtime scope to the canonical directory recursively via `FsExt::allow_directory(&canonical, true)` (T-01-01-E, RESEARCH §1.5 Risk 1), persists the canonical path in `VaultState`, and pushes to `recent-vaults.json`. `get_vault_stats` walks `.md` files and skips dot-dirs. `get_recent_vaults` reads the JSON from `app_data_dir()` with a missing-file fallback to empty list. All 6 Wave 0 VAULT-* test ignores flipped to assertions + 3 net-new pin tests (ISO-8601, RecentVault struct shape, hash known values).
- **File commands enforce vault-scope and UTF-8 at the read boundary.** `read_file` canonicalizes the target and asserts `canonical.starts_with(vault)` before opening — a frontend request for `/etc/passwd` returns `PermissionDenied` even though plugin-fs might otherwise allow it. `String::from_utf8` rejects non-UTF-8 bytes with `InvalidEncoding` (D-17), guaranteeing auto-save can never truncate a binary file loaded by accident. `write_file` canonicalizes the target's *parent*, re-asserts vault-scope, writes, and returns the SHA-256 hex hash of the bytes written (EDIT-10 groundwork). 7 tests pass covering UTF-8 reject, outside-vault reject for both read+write, FileNotFound, hash return value, and round-trip.
- **Wave 0 ignore gauge hit zero.** Started at 14 `#[ignore]`d stubs, ended at 0 `#[ignore]`s anywhere in `src-tauri/`. 26 tests pass total (8 ERR-01 + 6 VAULT-* original + 3 VAULT-* pin additions + 3 hash + 7 files) with zero ignored / zero failed. `cargo test --manifest-path src-tauri/Cargo.toml` exits 0.
- **Full workspace builds.** `cargo build --manifest-path src-tauri/Cargo.toml` exits 0 in ~5s incremental, and `pnpm typecheck` exits 0 — the backend-only plan did not regress the frontend.
- **Zero-network guarantee intact.** `grep -rE "(reqwest|hyper|ureq|surf|curl)" src-tauri/Cargo.toml` returns nothing. `grep -rE "http://|https://" src-tauri/src/` returns only a single comment inside `vault.rs` referencing Howard Hinnant's algorithm documentation URL — prose, not code, not imported anywhere.

## Task Commits

Each task was committed atomically:

1. **Task 1: VaultError enum with manual serde::Serialize + 8 ERR-01 tests** — `6f1d532` (feat)
2. **Task 2: vault commands + hash helper + VaultState + 9 vault tests** — `3dc5004` (feat)
3. **Task 3: files commands with UTF-8 + vault-scope guards + 7 file tests** — `f8f1011` (feat)

**Plan metadata commit:** (this SUMMARY.md + STATE/ROADMAP/REQUIREMENTS bumps) — committed after self-check

## Files Created/Modified

### Created

- `src-tauri/src/hash.rs` — `pub fn hash_bytes(&[u8]) -> String` with 3 unit tests (empty = known NIST vector, differs on content change, "hello" = known hex)
- `src-tauri/src/tests/files.rs` — 7 unit tests + `_impl` helper duplicates of the `read_file`/`write_file` bodies (see patterns-established)
- `.planning/phases/01-skeleton/01-01-backend-spine-SUMMARY.md` — this file

### Modified

- `src-tauri/src/error.rs` — Wave 0 `VaultError::Placeholder` replaced with full 8-variant enum. `variant_name()` + `extra_data()` helpers feed the manual `serde::Serialize` impl that emits `{ kind, message, data }`. `#[from] std::io::Error` handles ergonomic `?` conversions.
- `src-tauri/src/commands/vault.rs` — empty stub → full impl of `open_vault`, `get_recent_vaults`, `get_vault_stats`, `count_md_files`, `push_recent_vault_to`, `format_iso8601_utc`, private `read_recent_vaults_at`/`write_recent_vaults_at`/`recent_vaults_path`/`push_recent_vault` + `is_excluded` walkdir filter. All structs (`VaultInfo`, `VaultStats`, `RecentVault`) exported.
- `src-tauri/src/commands/files.rs` — empty stub → `read_file`, `write_file`, private `ensure_inside_vault` helper. Both commands match the `<interfaces>` block from the plan verbatim.
- `src-tauri/src/lib.rs` — `pub mod hash;`, `pub struct VaultState { current_vault: Mutex<Option<PathBuf>> }`, `.manage(VaultState::default())`, and `generate_handler!` with all 5 commands (vault ×3 + files ×2).
- `src-tauri/src/tests/mod.rs` — added `mod files;`
- `src-tauri/src/tests/error_serialize.rs` — 8 `#[ignore]`d stubs flipped to real assertions over the `{ kind, message, data }` contract via `serde_json::to_value`
- `src-tauri/src/tests/vault_stats.rs` — 6 `#[ignore]`d stubs flipped + 3 new pin tests (`format_iso8601_utc_matches_rfc3339`, `recent_vault_has_path_and_last_opened_fields`, `recent_vaults_dedupe_moves_to_front` last-opened refresh assertion)
- `src-tauri/Cargo.toml` — added `[dev-dependencies]` section with `tempfile = "3"` (dev-only, not subject to D-19 runtime crate allow-list)
- `src-tauri/Cargo.lock` — refreshed to include tempfile + rustix + linux-raw-sys + fastrand transitive deps

## Decisions Made

- **Hand-rolled ISO-8601 formatter instead of chrono/time.** D-19 Phase 1 crate allow-list forbids `chrono` and doesn't allow-list `time`. Pulling either would have been a scope creep for a 15-line function. Used Howard Hinnant's public-domain `civil_from_days` algorithm: pure std, no deps, validated against three pin points (Unix epoch, 2026-04-11, 2000-02-29 leap day sanity).
- **Test-side `_impl` duplication in `tests/files.rs`.** `tauri::State<'_, VaultState>` cannot be constructed outside a running Tauri app — there's no way to call the real `read_file`/`write_file` body from cargo test. I duplicated the bodies into `_impl` helpers that take `&VaultState` directly, with a comment enforcing they must stay in logical lockstep. The alternative — refactoring the real commands into `_impl` + thin `#[tauri::command]` shims — would spread the production code across two files forever for a Phase 1 convenience. Re-evaluate if Phase 5 EDIT-10 adds enough logic to make the helper expensive to maintain.
- **`read_file`'s `canonicalize` NotFound → `FileNotFound` (not `VaultUnavailable`).** A missing note is a different error class from a missing vault; the frontend needs to distinguish them for the toast message. `open_vault` maps the same error to `VaultUnavailable` because for that command the path IS the vault.
- **`write_file` canonicalizes parent, not target.** The target file may not exist yet (new note). Canonicalizing the parent and joining `file_name` back achieves the same symlink-escape protection as canonicalizing the full target would for an existing file, while correctly handling the create case.
- **Frontmatter `requirements-completed: [ERR-01, VAULT-02, VAULT-04, VAULT-05, VAULT-06]`.** VAULT-01 (native folder picker) is explicitly a frontend concern — the Rust-side sink `open_vault` exists but the UI that invokes `@tauri-apps/plugin-dialog` lives in plan 01-02. VAULT-03 (auto-load last vault on startup) is also 01-02 territory because it requires the Svelte store glue. VAULT-06 is implemented but was marked `x` pre-emptively in REQUIREMENTS.md by the roadmapper — the traceability table is already correct.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ISO-8601 formatter epoch constant for 2026-04-11 was off by 3 days**
- **Found during:** Task 2 (`cargo test format_iso8601_utc_matches_rfc3339` → `left: "2026-04-14T00:00:00Z" right: "2026-04-11T00:00:00Z"`)
- **Issue:** The initial test used `1_776_124_800` as the epoch for 2026-04-11T00:00:00Z. The Howard Hinnant formatter correctly produced `2026-04-14` for that epoch, meaning my pre-check was wrong by 3 days (259200 seconds) — the real epoch is `1_775_865_600`.
- **Fix:** Used the formatter itself as the source of truth and updated the test constant to `1_775_865_600`. This is the right direction (trust the tested algorithm, not the hand-math that could be off), and it kept the pin test honest: it verifies the formatter is stable against three points (Unix epoch = 0, 2026-04-11, leap day 2000-02-29), which is enough to catch a regression in the formula while allowing the constants to be adjusted when wrong.
- **Files modified:** `src-tauri/src/tests/vault_stats.rs` (test constant)
- **Verification:** `cargo test format_iso8601_utc_matches_rfc3339` passes. All three assertions (Unix epoch, 2026-04-11, 2000-02-29T12:34:56) pass under the same formula.
- **Committed in:** `3dc5004` (Task 2 commit)

**2. [Rule 3 - Blocking] Task 2 temporarily commented files commands out of invoke_handler! to allow an early build**
- **Found during:** Task 2 first `cargo test` run — compile error `could not find __cmd__read_file in files` because `commands/files.rs` was still the Wave 0 empty stub.
- **Issue:** The plan assumed Task 2 could populate `invoke_handler!` with all 5 commands, but `generate_handler!` resolves the macro arguments at compile time and requires every listed command to exist. Populating `files.rs` would have required jumping ahead into Task 3's scope from Task 2.
- **Fix:** Left a single-line comment placeholder in `lib.rs` for the file commands during Task 2, then restored the real `generate_handler!` with all 5 commands in Task 3 once `files.rs` was populated. The final state of `lib.rs` matches the plan's `<interfaces>` block exactly — this was a mid-task scratchpad that lasted one commit.
- **Files modified:** `src-tauri/src/lib.rs` (comment → commands, round-tripped across Task 2 and Task 3 commits)
- **Verification:** `cargo test` passes end-of-Task-2 with 3 vault commands registered, then again end-of-Task-3 with all 5 registered.
- **Committed in:** `3dc5004` (Task 2: comment placeholder) and `f8f1011` (Task 3: real entries restored)

---

**Total deviations:** 2 auto-fixed (1 test-constant math fix, 1 scratchpad to unblock cross-task compile order)
**Impact on plan:** Neither changed the shipped API or the frontmatter contract. Both were execution-mechanics adjustments. The final `lib.rs` / `files.rs` / `vault.rs` surfaces match the plan's `<interfaces>` block byte-for-byte.

## Issues Encountered

- **Forward reference in `invoke_handler!`** — described under Deviations #2 above. A cleaner phrasing would have been "Task 2 ships the vault commands and wires them into `invoke_handler!`; Task 3 appends the file command entries." Re-splitting the work like that is the lesson for future plans that share a `generate_handler!` across multiple tasks.
- **Linux webkit2gtk-4.1 deps already installed** — inherited from the 01-00 user fix, so this plan had no environment blockers.

## User Setup Required

None. All deps are either pre-installed (webkit2gtk, etc. from 01-00) or pulled from crates.io by cargo (tempfile + transitive).

## Self-Check: PASSED

Verified on 2026-04-11T21:05:30Z:

- **All 3 created files exist on disk:** `src-tauri/src/hash.rs` FOUND, `src-tauri/src/tests/files.rs` FOUND, `.planning/phases/01-skeleton/01-01-backend-spine-SUMMARY.md` FOUND (this file).
- **All 3 task commits present in git log:** `6f1d532` FOUND (VaultError), `3dc5004` FOUND (vault commands), `f8f1011` FOUND (files commands).
- **Grep acceptance criteria all green:**
  - `impl serde::Serialize for VaultError` × 1 in error.rs
  - `#[from] std::io::Error` × 1 in error.rs
  - `#[ignore` × 0 across `src-tauri/` (was 14 in 01-00)
  - `allow_directory` × 1 in commands/vault.rs
  - `canonicalize` × 3 in commands/vault.rs
  - `MAX_RECENT: usize = 10` × 1 in commands/vault.rs
  - `fn format_iso8601_utc` × 1 in commands/vault.rs
  - `InvalidEncoding` × 2 in commands/files.rs
  - `starts_with(vault)` × 2 in commands/files.rs
  - `String::from_utf8` × 1 in commands/files.rs
  - `hash_bytes` × 2 in commands/files.rs
- **Tests green:** `cargo test --manifest-path src-tauri/Cargo.toml` → 26 passed / 0 failed / 0 ignored.
- **Build green:** `cargo build --manifest-path src-tauri/Cargo.toml` exit 0; `pnpm typecheck` exit 0.
- **Zero-network guarantee:** `grep -rE "(reqwest|hyper|ureq|surf|curl)" src-tauri/Cargo.toml` returns nothing; `grep -rE "http://|https://" src-tauri/src/` returns only the Howard Hinnant documentation comment URL (prose, not a runtime call).

## Next Phase Readiness

- **Plan 01-02 (frontend welcome) is unblocked.** Every command from the `<interfaces>` block is exported and registered — `open_vault(path)` returns `VaultInfo`, `get_recent_vaults()` returns `Vec<RecentVault>`, `get_vault_stats(path)` returns `VaultStats`, `read_file(path)` returns `String` or `InvalidEncoding`, `write_file(path, content)` returns SHA-256 hex hash. The frontend IPC wrapper (`src/ipc/commands.ts`) can treat this as a stable contract.
- **Plan 01-03 (editor autosave) can rely on** `read_file` never loading non-UTF-8 bytes (no corruption risk) and `write_file` returning the hash of each successful write (EDIT-10 groundwork).
- **Plan 01-04 (progress + filelist wireup)** will extend `count_md_files` into an event-emitting walk and reuse `VaultState.current_vault` as the walk root.
- **No blockers for downstream waves.** The only test-side duplication (`_impl` helpers in `tests/files.rs`) is flagged in the code and in this summary; any future refactor can be done surgically without breaking the command surface.

---
*Phase: 01-skeleton*
*Completed: 2026-04-11*
