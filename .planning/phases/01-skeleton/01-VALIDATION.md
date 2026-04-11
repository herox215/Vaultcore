---
phase: 1
slug: skeleton
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-11
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Sourced from RESEARCH.md §7 Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework (frontend)** | Vitest 4.1.4 + @testing-library/svelte 5.3.1 + jsdom |
| **Framework (backend)** | `cargo test` (Rust built-in) |
| **Config file** | `vitest.config.ts` (Wave 0 gap — does not exist yet) |
| **Quick run command** | `pnpm vitest run` |
| **Full suite command** | `pnpm vitest run && cargo test --manifest-path src-tauri/Cargo.toml` |
| **Estimated runtime** | ~30 s (frontend) + ~10 s (cargo) = ~40 s full suite |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run` (frontend unit tests, <30 s)
- **After every plan wave:** Run `pnpm vitest run && cargo test --manifest-path src-tauri/Cargo.toml` (full suite)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 40 s

---

## Per-Task Verification Map

> Task IDs are allocated by the planner. This table maps REQ-IDs to test types and commands; the planner must assign each REQ to a concrete task ID and mark `File Exists` ✅ once Wave 0 scaffolds the test file.

| REQ-ID | Behavior | Test Type | Automated Command | File Exists | Status |
|--------|----------|-----------|-------------------|-------------|--------|
| VAULT-01 | Native folder picker invoked + path returned | Vitest (mock dialog plugin) + manual | `pnpm vitest run tests/vault.test.ts` | ❌ W0 | ⬜ pending |
| VAULT-02 | `recent-vaults.json` write/read round-trip | Cargo test + Vitest (store) | `cargo test recent_vaults` / `pnpm vitest run tests/vault.test.ts` | ❌ W0 | ⬜ pending |
| VAULT-03 | Last vault auto-loaded on startup | Manual E2E only | Manual | N/A | ⬜ pending |
| VAULT-04 | Recent list caps at 10 (FIFO eviction) | Cargo test or Vitest (whichever owns eviction) | `cargo test recent_vaults_eviction` | ❌ W0 | ⬜ pending |
| VAULT-05 | Unreachable vault → Welcome + toast (no crash) | Manual + Vitest unit (store fallback) | `pnpm vitest run tests/vault.test.ts` | ❌ W0 | ⬜ pending |
| VAULT-06 | `get_vault_stats` returns file count | Cargo test with temp dir | `cargo test get_vault_stats` | ❌ W0 | ⬜ pending |
| IDX-02 | Progress events emitted with correct payload | Vitest (mock `listen` + event assertion) + manual visual | `pnpm vitest run tests/indexProgress.test.ts` | ❌ W0 | ⬜ pending |
| EDIT-01 | Markdown syntax highlighting renders | Manual visual inspection | Manual | N/A | ⬜ pending |
| EDIT-02 | H1/H2/H3 visually larger, bold/italic/inline-code styled | Manual visual inspection | Manual | N/A | ⬜ pending |
| EDIT-04 | Cmd/Ctrl+B/I/K wrap current selection | Vitest unit for `wrapSelection` helper | `pnpm vitest run tests/keymap.test.ts` | ❌ W0 | ⬜ pending |
| EDIT-09 | Auto-save fires ~2s after last keystroke | Vitest with fake timers + manual wall-clock | `pnpm vitest run tests/autoSave.test.ts` | ❌ W0 | ⬜ pending |
| UI-04 | Toast renders error / clean-merge / conflict variants | Vitest component test | `pnpm vitest run tests/Toast.test.ts` | ❌ W0 | ⬜ pending |
| ERR-01 | VaultError enum serializes to `{kind, message, data}` | Cargo test per variant | `cargo test vault_error_serialize` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

All test files must exist (can be skeleton/empty) before any task in Wave 1+ begins. Planner MUST inject a Wave 0 that creates:

- [ ] `vitest.config.ts` — Vitest configuration (jsdom env, svelte plugin, setupFiles)
- [ ] `src/test/setup.ts` — test setup (jest-dom matchers, fake timers helper)
- [ ] `tests/vault.test.ts` — stubs for VAULT-01, VAULT-02, VAULT-05
- [ ] `tests/WelcomeScreen.test.ts` — VAULT-04-adjacent component smoke test
- [ ] `tests/indexProgress.test.ts` — IDX-02 event mock
- [ ] `tests/keymap.test.ts` — EDIT-04 `wrapSelection` stub
- [ ] `tests/autoSave.test.ts` — EDIT-09 debounce with fake timers
- [ ] `tests/Toast.test.ts` — UI-04 variant stubs
- [ ] `src-tauri/src/tests/error_serialize.rs` or `#[cfg(test)]` mod — ERR-01 serde round-trip
- [ ] `src-tauri/src/tests/vault_stats.rs` or `#[cfg(test)]` mod — VAULT-06 walkdir counter, VAULT-04 eviction
- [ ] Framework install: `pnpm add -D vitest@^4 @testing-library/svelte@^5 @sveltejs/vite-plugin-svelte jsdom @testing-library/jest-dom`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Auto-load last vault on cold start | VAULT-03 | Requires full app restart cycle; Tauri test driver out of scope for Phase 1 | 1. Open a vault, 2. Quit app, 3. Relaunch `tauri dev`, 4. Assert vault opens without showing Welcome |
| Markdown syntax highlighting visual quality | EDIT-01 | Visual correctness is aesthetic, not functional | Open a `.md` file with `# H1`, `**bold**`, `*italic*`, `` `code` ``, `- list`; confirm each renders styled |
| Live-preview: heading size hierarchy | EDIT-02 | Visual comparison vs. spec §6.3 | Open a `.md` file with H1/H2/H3; visually confirm descending sizes |
| Native folder picker (OS dialog appearance) | VAULT-01 | Cannot assert on native OS chrome | Click "Open vault"; confirm native dialog opens and selection returns a path |
| 60 fps keystroke responsiveness | success criterion 3 | DevTools frame profiling, not a test assertion | Type rapidly in the editor; confirm no visible lag (Phase 6 will add formal benchmarks) |
| Toast visible on vault-unreachable | VAULT-05 | Tauri test driver not set up | Point `recent-vaults.json` at a nonexistent path; relaunch; confirm Welcome screen + toast |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (vitest config, all test files, cargo test modules)
- [ ] No watch-mode flags in commands (`vitest run`, not `vitest`)
- [ ] Feedback latency < 40 s
- [ ] `nyquist_compliant: true` set in frontmatter once planner wires every task to this table

**Approval:** pending
