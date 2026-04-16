<div align="center">

# VaultCore

*Your second brain, but it can run on a potato.*

Open-source · Markdown-first · Local-first · Not built on Electron

[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue?logo=tauri)](https://tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte-5-orange?logo=svelte)](https://svelte.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust)](https://rust-lang.org)

</div>

---

> **Status: Work in Progress.** VaultCore is under active development and not yet production-ready. Expect breaking changes, missing features, and sharp edges. Don't point it at your only copy of anything important.

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
git clone https://github.com/herox215/Vaultcore.git
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

## End-to-end tests

The E2E suite (42 specs) runs real WebDriver sessions against a release build of the app via [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/). Linux only — tauri-driver does not support macOS, and Windows support is not wired up yet.

One-time setup:

```bash
cargo install tauri-driver          # spawns the WebDriver bridge
sudo pacman -S webkitgtk-6.0        # ships /usr/bin/WebKitWebDriver (Arch)
                                     # Debian/Ubuntu: apt install webkit2gtk-driver
```

Running the suite:

```bash
# 1. Build the release binary with the E2E hook enabled.
#    (Only needed after changes to frontend or Rust code.)
VITE_E2E=1 pnpm tauri build --no-bundle

# 2. Start tauri-driver in the background (port 4444, spawns WebKitWebDriver on 4445).
tauri-driver --port 4444 &

# 3. Run the full suite …
pnpm test:e2e

# … or a single spec.
pnpm test:e2e --spec ./e2e/specs/search.spec.ts
```

The `VITE_E2E=1` flag exposes a `window.__e2e__` hook so specs can bypass native pickers, drive stores directly, and inject text into the CodeMirror view. It is tree-shaken out of non-E2E builds. Current surface:

| Hook | Purpose |
| --- | --- |
| `loadVault(path)` / `switchVault(path)` / `closeVault()` | Vault lifecycle without the native file picker |
| `pushToast(variant, message)` | Exercise the toast renderer from async failure paths |
| `startProgress` / `updateProgress` / `finishProgress` | Drive the indexing-progress overlay deterministically |
| `typeInActiveEditor(text)` | Dispatch a CM6 transaction — WebKit driver keystrokes don't reach contenteditable |

Three specs are marked `describe.skip` with inline rationale: `drag-drop` (WebKit can't carry `DataTransfer.setData` across synthetic events), `local-graph` (panel is built but not mounted in the current layout), `index-repair` (needs a Rust-side hook to poison the Tantivy index).

## Contributing

PRs welcome. Run `pnpm test` and `pnpm typecheck` before submitting — broken tests make CI cry.

## License

MIT — see [LICENSE](LICENSE).

---

*Built with 🦀 by people who think Electron is a subatomic particle, not an app framework.*