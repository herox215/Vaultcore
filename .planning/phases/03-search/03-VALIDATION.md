---
phase: 3
slug: search
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-12
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend), cargo test (Rust backend) |
| **Config file** | `vitest.config.ts`, `src-tauri/Cargo.toml` |
| **Quick run command** | `pnpm vitest run --reporter=verbose && cd src-tauri && cargo test` |
| **Full suite command** | `pnpm vitest run && cd src-tauri && cargo test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --reporter=verbose && cd src-tauri && cargo test`
- **After every plan wave:** Run full suite command
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-T1 | 01 | 1 | IDX-01, IDX-05, IDX-06, IDX-08 | T-03-01, T-03-04 | strip_markdown plain-text only; .vaultcore dot-prefix hidden | unit + compile | `cd src-tauri && cargo check 2>&1 \| tail -5` | pending | pending |
| 03-01-T2 | 01 | 1 | IDX-01, IDX-03, IDX-04, ERR-02 | T-03-02, T-03-03, T-03-05 | mpsc queue serialization; auto-rebuild on corrupt; vault-scope guard | unit + tdd | `cd src-tauri && cargo test 2>&1 \| tail -20` | pending | pending |
| 03-02-T1 | 02 | 2 | IDX-09, SRCH-02, SRCH-03, SRCH-04, SRCH-05 | T-03-06, T-03-07, T-03-08 | parse_query_lenient; snippet HTML safe; result cap | compile | `cd src-tauri && cargo check 2>&1 \| tail -5` | pending | pending |
| 03-02-T2 | 02 | 2 | SRCH-02, SRCH-04 | — | — | compile | `cd /home/sokragent/Projects/vaultcore && npx tsc --noEmit 2>&1 \| tail -10` | pending | pending |
| 03-03-T1 | 03 | 3 | SRCH-01 | — | — | compile | `cd /home/sokragent/Projects/vaultcore && npx tsc --noEmit 2>&1 \| tail -10` | pending | pending |
| 03-03-T2 | 03 | 3 | SRCH-01, SRCH-06 | T-03-09, T-03-10 | snippet {@html} safe (pulldown-cmark stripped); 200ms debounce | compile | `cd /home/sokragent/Projects/vaultcore && npx tsc --noEmit 2>&1 \| tail -10` | pending | pending |
| 03-04-T1 | 04 | 4 | SRCH-04, SRCH-06 | T-03-11 | no debounce acceptable (nucleo <10ms) | compile | `cd /home/sokragent/Projects/vaultcore && npx tsc --noEmit 2>&1 \| tail -10` | pending | pending |
| 03-04-T2 | 04 | 4 | SRCH-06 | T-03-12 | flash decoration uses hardcoded CSS class | compile | `cd /home/sokragent/Projects/vaultcore && npx tsc --noEmit 2>&1 \| tail -10` | pending | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [x] `src-tauri/src/indexer/` — Tantivy indexer module with unit tests (Plan 01 Task 1 creates skeleton, Task 2 adds tests)
- [x] `src-tauri/src/commands/search.rs` — search commands with unit tests (Plan 02 Task 1)
- [x] `src/store/searchStore.ts` — search state store (Plan 02 Task 2)
- [x] `src/components/Search/` — search panel components (Plan 03 Task 2)

*All auto tasks have `<automated>` verify commands — no MISSING references.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Quick Switcher responds within 10ms | SRCH-04 | Performance benchmark needs 100k vault | Generate 100k test vault, measure keystroke-to-result time |
| Full-text search < 50ms | SRCH-02 | Performance benchmark needs 100k vault | Generate 100k test vault, measure query-to-result time |
| Cmd/Ctrl+Shift+F opens search panel | SRCH-01 | Keyboard shortcut in Tauri webview | Press shortcut, verify panel opens |
| Cmd/Ctrl+P opens Quick Switcher | SRCH-04 | Keyboard shortcut in Tauri webview | Press shortcut, verify modal opens |
| Flash-highlight on scroll-to-match | SRCH-06 | Visual behavior | Click result, verify yellow flash at match location |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
