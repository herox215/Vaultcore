---
phase: 2
slug: vault
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-12
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (frontend) + cargo test (backend) |
| **Config file** | `vitest.config.ts` / `Cargo.toml` |
| **Quick run command** | `cd src-tauri && cargo test --lib && cd .. && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command (cargo test --lib + vitest run)
- **After every plan wave:** Run full suite command
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 0 | FILE-01 | T-02-01 / — | Lazy tree only loads root entries | unit | `cargo test tree` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 0 | FILE-02 | — | Create file in selected folder | unit | `cargo test create_file` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 0 | FILE-03 | — | Rename with wiki-link count prompt | unit | `cargo test rename_file` | ❌ W0 | ⬜ pending |
| 02-01-04 | 01 | 0 | FILE-04 | — | Delete moves to .trash/ | unit | `cargo test delete_file` | ❌ W0 | ⬜ pending |
| 02-01-05 | 01 | 0 | FILE-05 | — | Move via drag-drop | unit | `cargo test move_file` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 1 | EDIT-05 | — | Multi-tab open/close/cycle | component | `npx vitest run --grep tab` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 1 | EDIT-06 | — | Split-view two panes | component | `npx vitest run --grep split` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 2 | SYNC-01 | T-02-02 | Watcher detects external changes | integration | `cargo test watcher` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 2 | SYNC-02 | — | Three-way merge non-conflicting | unit | `cargo test merge` | ❌ W0 | ⬜ pending |
| 02-03-03 | 03 | 2 | SYNC-03 | — | Three-way merge conflicting keeps local | unit | `cargo test merge_conflict` | ❌ W0 | ⬜ pending |
| 02-03-04 | 03 | 2 | SYNC-05 | — | Write-token filters own writes | unit | `cargo test write_token` | ❌ W0 | ⬜ pending |
| 02-03-05 | 03 | 2 | SYNC-07 | — | Bulk threshold switches to progress UI | integration | `cargo test bulk_change` | ❌ W0 | ⬜ pending |
| 02-04-01 | 04 | 3 | ERR-03 | — | Vault unmount disables editing | integration | `cargo test vault_unmount` | ❌ W0 | ⬜ pending |
| 02-04-02 | 04 | 3 | ERR-04 | — | Disk-full surfaces toast, preserves buffer | integration | `cargo test disk_full` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/tree.rs` — test stubs for FILE-01 (list_directory, lazy load)
- [ ] `src-tauri/src/commands/files.rs` — test stubs for FILE-02..05 (create, rename, delete, move)
- [ ] `src-tauri/src/watcher.rs` — test stubs for SYNC-01..08 (watcher, merge, write-token, bulk)
- [ ] `src-tauri/src/merge.rs` — test stubs for three-way merge
- [ ] `src/components/Sidebar/` — Vitest stubs for tree component
- [ ] `src/components/TabBar/` — Vitest stubs for tab management
- [ ] `src/store/tabStore.ts` — Vitest stubs for tab state

*Existing Phase 1 test infrastructure (Vitest + cargo test) covers framework setup.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Drag-drop move in sidebar | FILE-05 | Requires mouse drag interaction | 1. Drag a file to another folder 2. Verify it moves on disk 3. Verify open tab updates path |
| Drag tab to edge for split | EDIT-06 | Requires mouse drag to editor edge | 1. Open 2+ tabs 2. Drag tab to right edge 3. Verify 2-pane split appears |
| Vault unmount recovery | ERR-03 | Requires external FS unmount | 1. Open vault 2. Unmount vault drive 3. Verify readonly + toast 4. Remount 5. Verify editing re-enabled |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
