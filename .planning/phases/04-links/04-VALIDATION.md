---
phase: 4
slug: links
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-12
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend) + cargo test (Rust) |
| **Config file** | `vite.config.ts` (vitest) / `Cargo.toml` (cargo test) |
| **Quick run command** | `cd src-tauri && cargo test --lib` |
| **Full suite command** | `cd src-tauri && cargo test --lib && cd .. && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test --lib`
- **After every plan wave:** Run `cd src-tauri && cargo test --lib && cd .. && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | LINK-08 | — | N/A | unit | `cargo test link_graph` | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | LINK-02 | — | N/A | unit | `cargo test link_resolution` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | LINK-01 | — | N/A | integration | `npx vitest run --grep wikilink` | ❌ W0 | ⬜ pending |
| 04-02-02 | 02 | 1 | LINK-04 | — | N/A | integration | `npx vitest run --grep unresolved` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 2 | LINK-05 | — | N/A | integration | `npx vitest run --grep autocomplete` | ❌ W0 | ⬜ pending |
| 04-03-02 | 03 | 2 | LINK-06 | — | N/A | unit | `cargo test backlinks` | ❌ W0 | ⬜ pending |
| 04-04-01 | 04 | 3 | LINK-09 | — | N/A | unit | `cargo test rename_cascade` | ❌ W0 | ⬜ pending |
| 04-04-02 | 04 | 3 | LINK-07 | — | N/A | unit | `cargo test unresolved_links` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/tests/link_graph.rs` — stubs for LINK-02, LINK-07, LINK-08
- [ ] `src-tauri/src/tests/links.rs` — stubs for LINK-09 rename cascade
- [ ] Existing test infrastructure covers framework needs (vitest + cargo test already configured)

*Existing infrastructure covers framework install — only test stubs needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Wiki-link click opens tab | LINK-03 | Requires CM6 editor interaction + Tauri IPC | Click a `[[link]]` in editor, verify target opens in new tab |
| `[[` autocomplete popup appears | LINK-05 | Requires CM6 editor interaction | Type `[[` in editor, verify popup renders with matching filenames |
| Rename confirmation dialog | LINK-09 | Requires UI interaction | Rename a file with backlinks, verify dialog shows count, confirm, verify links updated |
| Right sidebar toggle | LINK-06 | Requires keyboard shortcut + layout | Press Cmd/Ctrl+Shift+B, verify sidebar opens/closes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
