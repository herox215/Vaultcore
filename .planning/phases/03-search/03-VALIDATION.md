---
phase: 3
slug: search
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| *Populated after plans are created* | | | | | | | | | |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/indexer/` — Tantivy indexer module with unit tests
- [ ] `src-tauri/src/commands/search.rs` — search commands with unit tests
- [ ] `src/store/searchStore.ts` — search state store
- [ ] `src/components/Search/` — search panel components

*Existing vitest and cargo test infrastructure covers the framework need.*

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

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
