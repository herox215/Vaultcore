<div align="center">

# VaultCore

*Your second brain, but it can run on a potato.*

Open-source · Markdown-first · Local-first · Not built on Electron

[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue?logo=tauri)](https://tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte-5-orange?logo=svelte)](https://svelte.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust)](https://rust-lang.org)

</div>

---

Obsidian is great. Shipping an entire Chromium to edit a `.md` file is... a choice. VaultCore takes the ideas that make Obsidian brilliant — wikilinks, graph view, backlinks, local-first everything — and puts them on a stack that doesn't need a cooling pad.

**Rust backend. Svelte frontend. Native webview.** No Electron. No 500MB RAM for a text editor.

## What it does

- **Markdown editor** with live preview and `[[wikilinks]]`
- **Bidirectional links** — backlinks, outgoing links, the whole conversation
- **Graph view** — visualize your knowledge graph (without your RAM filing for divorce)
- **Full-text search** — Tantivy-powered, finds anything instantly
- **YAML frontmatter** — metadata for the organized (and the aspirationally organized)
- **Command palette** — `Ctrl+P`, because clicking is so 2019
- **Local-first, always** — plain Markdown files on your disk. No cloud hostage situations

## Quick start

```bash
git clone https://github.com/your-org/vaultcore.git
cd vaultcore
pnpm install
pnpm tauri dev
```

Needs: [Node.js](https://nodejs.org) ≥ 22, [pnpm](https://pnpm.io) ≥ 9, [Rust](https://rustup.rs) ≥ 1.77, and [Tauri deps](https://v2.tauri.app/start/prerequisites/).

Build a release binary:

```bash
pnpm tauri build
```

## Stack

```
Svelte 5 + TailwindCSS 4 + CodeMirror 6
              ↕ Tauri v2 ↕
Rust · Tantivy · Tokio · Rayon
```

## Contributing

PRs welcome. Run `pnpm test` and `pnpm typecheck` before submitting — broken tests make CI cry.

## License

TBD

---

*Built with 🦀 by people who think Electron is a subatomic particle, not an app framework.*