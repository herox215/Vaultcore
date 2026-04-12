---
phase: 5
slug: polish
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-12
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend) + cargo test (Rust) |
| **Config file** | `vite.config.ts` (vitest) / `Cargo.toml` (cargo test) |
| **Quick run command** | `cd src-tauri && cargo test --lib` |
| **Full suite command** | `cd src-tauri && cargo test --lib && cd .. && npx vitest run` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test --lib`
- **After every plan wave:** Run `cd src-tauri && cargo test --lib && cd .. && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | TAG-01, TAG-02 | unit | `cargo test tag_index` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | TAG-03, TAG-04 | integration | `cargo test --test tags_ops` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 2 | UI-01 | integration | `npx vitest run --grep theme` | ❌ W0 | ⬜ pending |
| 05-02-02 | 02 | 2 | UI-02 | integration | `npx vitest run --grep settings` | ❌ W0 | ⬜ pending |
| 05-03-01 | 03 | 2 | UI-05, UI-03, EDIT-11 | integration | `npx vitest run --grep shortcuts` | ❌ W0 | ⬜ pending |
| 05-04-01 | 04 | 2 | EDIT-10 | integration | `npx vitest run --grep hash-verify` | ❌ W0 | ⬜ pending |
| 05-05-01 | 05 | 2 | EDIT-03 | integration | `npx vitest run --grep code-fence` | ❌ W0 | ⬜ pending |
| 05-06-01 | 06 | 2 | FILE-06, FILE-07 | integration | `npx vitest run --grep tree-state` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/tests/tag_index.rs` — unit stubs for tag extraction (inline, YAML, edge cases)
- [ ] `src-tauri/Cargo.toml` — add `serde_yml = "0.0.12"` (serde_yaml is deprecated per research)
- [ ] `package.json` — add `@codemirror/language-data`, `@fontsource/inter`, `@fontsource/lora`, `@fontsource/jetbrains-mono`, `@fontsource/fira-code`
- [ ] Extend `DirEntry` struct in Rust with `modified_ms` and `created_ms` (FILE-06 prerequisite)
- [ ] Change `theme.ts` `fontSize: "15px"` → `var(--vc-font-size)` (D-09 prerequisite)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Theme switch live | UI-01 | Visual inspection in Tauri webview | Open Settings, toggle light/dark/auto, verify all surfaces update |
| Font family/size live | UI-02 | Visual — fonts render differently | Settings → pick Inter, slider to 18px → editor text updates |
| Cmd/Ctrl+\ toggles sidebar | UI-03 | Keyboard interaction | Press in editor → sidebar collapses; press again → expands |
| Cmd/Ctrl+N creates note | EDIT-11 | Full flow with InlineRename | Press in editor → new tab opens with InlineRename focused |
| Tag panel click opens search | TAG-04 | Cross-panel interaction | Click `#rust` in tag panel → Search tab active with `#rust` query |
| Hash-verify merge toast | EDIT-10 | Requires external file mutation | Open file, edit it externally, wait for auto-save → clean-merge toast |
| Sort/expand persists | FILE-06/07 | Session restart required | Expand folders, change sort → close + reopen app → state preserved |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
