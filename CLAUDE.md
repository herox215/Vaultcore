## Project

**VaultCore**

A local, Markdown-first note and knowledge-management desktop app — a modern, minimally styled note-taking tool. Clean, dense, keyboard-first, no decoration. Performance is a first-class concern. Files stay as plain Markdown on disk — no proprietary format, no cloud, no telemetry.

**Core Value:** **Stay fluid at 100,000+ notes.** Open, search, link, and edit a vault of that size without perceptible lag. If this fails, VaultCore has no reason to exist — everything else is negotiable.

### Constraints

- **Tech stack**: Tauri 2 + Rust backend, TypeScript + CodeMirror 6 frontend, Tantivy for full-text search, `notify` for FS watching, Zustand for state, Tailwind for styling — locked by spec Section 2.
- **Performance (100k-note vault, ~500 words/file)**:
  - Cold start < 3 s, warm start < 5 s
  - Open note < 100 ms, keystroke latency < 16 ms (60 fps)
  - Full-text search < 50 ms, quick switcher < 10 ms
  - Backlinks < 20 ms, link autocomplete < 10 ms
  - Initial indexing < 60 s, incremental update < 5 ms
  - RAM idle < 100 MB, active < 250 MB
- **Platforms**: macOS (Intel + Apple Silicon), Windows 10/11, Linux (Ubuntu 22.04+, Fedora 38+). No other targets in MVP.
- **Security**: zero network calls, zero telemetry, files never leave disk. Non-negotiable.
- **Compatibility**: must open existing Obsidian vaults without corrupting them. Shortest-path link resolution is spec-prescribed (exact match in same folder → shortest relative path → alphabetical tiebreak).
- **Crash recovery**: ≤ 2 s of unsaved content loss is acceptable; no write-ahead log in MVP.

## Technology Stack

Technology stack not yet documented.

## Conventions

### Testing scope

- Run only the tests affected by the current change — individual Vitest files and the specific WDIO specs that cover the touched behaviour.
- Do **not** run the full E2E suite on every change. Reserve the full suite for explicit user requests or final pre-merge regression checks when the change has broad blast radius (shared theme, editor core, store layer, etc.).

### Feature / bug / fix workflow

Every task — feature, bug, or small fix — follows these steps. Parallelize with subagents wherever steps are independent.

**Trivial-change exception:** Changes that are clearly trivial — typos, doc tweaks, comment fixes, ≤ 20 LOC confined to a single file, no architectural or cross-module impact — skip Socrates (step 3) and may skip Aristotle (step 9) at the implementer's discretion. Ticket + PR + tests still apply. If in doubt, run the full flow.

1. **Ensure a ticket exists.** Check GitHub first. If none exists, do a short scoped research pass (don't overshoot), describe in broad terms what needs to be done, ask the user about anything unclear, then open the issue.
   - **If the work touches UI, visual design, or interaction patterns**, consult **Vitruvius** before or while drafting the ticket. Vitruvius returns a design brief plus a short constraint list to embed in the ticket body, and surfaces open design questions (style, placement, interaction) to be answered by the user before the issue is filed. Skip this sub-step for pure backend / non-visual work.

2. **Draft a plan.** Describe *what* will be done.
   - The plan must account for clean architecture — respect module boundaries, follow existing codebase patterns, no shortcuts.
   - **Boy Scout rule**: if bad code, legacy cruft, or questionable patterns turn up in the affected area, note them in the plan and fold the correction into scope. Keep scope pragmatic — don't refactor half the codebase, but leave touched code better than you found it.

3. **Plan review by Socrates** (parallel where possible).
   - Looks for blind spots, missing steps, and contradictions.
   - Reviews architecture explicitly — bad patterns, layering violations, deviations from codebase conventions must be called out.
   - Also flags missed Boy Scout opportunities — nearby cruft the plan should have folded in.

4. **Fix the plan.** The planning agent incorporates the review.

5. **Tests first (TDD, non-negotiable).** Write new tests for the feature or bug. If tests covering the behavior already exist, verify they are still correct — don't add a redundant test just for ceremony, but never proceed without coverage.

6. **Implement** the change per the plan.

7. **Run the affected tests.** They must be green. If red → **fix the code, not the tests** (the tests are the spec).

8. **Open a PR** with a clear summary, rationale, and test plan.

9. **PR review by Aristotle.** Aristotle must post **inline comments on the specific lines in GitHub** — not just a summary comment on the PR. Looks for bugs, code smells, annotations, architecture regressions.

10. **Address the review.** The implementing agent resolves the inline comments and pushes fixes.

11. **Re-review.** Reviewer checks the fixes; loop until clean. **Maximum 2 iterations** — if it hasn't converged by then, escalate to the user rather than spinning in circles.

12. **User acceptance test (gate).** The user accepts manually. No merge without UAT.

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
