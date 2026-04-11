<!-- GSD:project-start source:PROJECT.md -->
## Project

**VaultCore**

A local, Markdown-first note and knowledge-management desktop app positioned as a faster Obsidian alternative. VaultCore is built for power users whose vaults have grown past the point where Obsidian starts to lag (≈100,000+ notes) and who want to keep their files as plain Markdown on disk — no proprietary format, no cloud, no telemetry.

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
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
