<div align="center">

# VaultCore

*A local-first knowledge base that doesn't ship a browser to edit text files.*

Open-source · Markdown-first · Local-first · Native webview, no Electron

[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue?logo=tauri)](https://tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte-5-orange?logo=svelte)](https://svelte.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust)](https://rust-lang.org)

</div>

---

> **Status: Work in Progress.** Under active development, not production-ready. Expect breaking changes and sharp edges. Don't point it at your only copy of anything important.

---

Obsidian-style wikilinks, graph, and backlinks — on a Rust + Svelte + native webview stack instead of a bundled Chromium. Your notes stay plain `.md` files on disk.

## Features

### Editor
- **Live-preview markdown** in CodeMirror 6 with `[[wikilinks]]`, `[[target|aliases]]`, embeds (`![[note]]`, `![[image.png|300]]`), callouts, task lists, tables, and a reading-mode toggle
- **Template expressions** — write `{{ ... }}` inline and it evaluates against your vault (folders, collections, `folder.notes`, `.join(...)`, chained with `;`), rendered as a live widget — tables included
- **Right-click template builder** — visual picker for expressions so you don't have to memorize the grammar
- **Autocomplete** for `[[wikilinks`, `#tags`, and template expressions, with fuzzy matching and resolved-target hints
- **YAML frontmatter** via a properties panel (key/value or list-style)

### Search
- **Full-text search** — Tantivy-backed BM25 with AND / OR / NOT / phrase queries, lenient enough for live typing
- **Semantic search** — multilingual-e5-small (INT8 ONNX) running locally, resumable reindex, persisted HNSW with mmap reload
- **Hybrid search** — Reciprocal Rank Fusion over BM25 + vector hits, with a match-% badge so you know *why* something ranked
- **OmniSearch** (`Ctrl`/`Cmd`+`K`) — unified modal for filename, content, tag, and semantic queries, with recent-files memory

### Graph
- **Force-directed graph** over your wikilink topology (Sigma.js), with adjustable link distance, repulsion, and damping
- **Embedding graph mode** — second view where edges come from semantic similarity instead of explicit links
- **Cluster slider** — collapse similar notes into super-nodes so you can actually see the shape of a big vault
- **Visibility-aware** — sim + render pause when the tab is hidden, so the graph doesn't eat your battery in the background

### Vault
- **File tree, tabs, breadcrumbs** — the usual, plus multi-vault switching from settings
- **Live file watcher** — create / rename / delete / modify events feed straight into the index and link graph, debounced, with a progress overlay for bulk changes (e.g. after a `git pull`)
- **Backlinks & outgoing links** — both update live as you type
- **Rename cascade** — rewrites every wikilink that pointed at the renamed file, with confirmation
- **Canvas** — `.canvas` files with nodes, edges, and inline embedding into notes; per-vault `home.canvas` on the sidebar vault-name click

### Rest of the kit
- **Command palette** (`Ctrl`/`Cmd`+`P`) with fuzzy search and MRU tracking
- **Customizable hotkeys** with conflict detection
- **Themes, font stack, font size** in settings
- **Daily notes** — folder / format / template
- **Templates** — `.md` files in `.vaultcore/templates/` with date, time, and title substitutions
- **Bookmarks, tags, and outline panels** in the sidebar

## Quick start

```bash
git clone https://github.com/herox215/Vaultcore.git
cd Vaultcore
pnpm install
pnpm tauri dev
```

Prerequisites: [Node.js](https://nodejs.org) ≥ 22, [pnpm](https://pnpm.io) ≥ 9, [Rust](https://rustup.rs) ≥ 1.77, and [Tauri deps](https://v2.tauri.app/start/prerequisites/) for your OS.

Release build:

```bash
pnpm tauri build
```

## Stack

```
Svelte 5 + TailwindCSS 4 + CodeMirror 6
              ↕ Tauri v2 ↕
Rust · Tantivy · Tokio · Rayon · ONNX Runtime · HNSW
```

## End-to-end tests

The E2E suite runs real WebDriver sessions against a release build via [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/). **Linux only** — tauri-driver has no macOS support, and Windows isn't wired up yet.

One-time setup:

```bash
cargo install tauri-driver          # spawns the WebDriver bridge
sudo pacman -S webkitgtk-6.0        # ships /usr/bin/WebKitWebDriver (Arch)
                                     # Debian/Ubuntu: apt install webkit2gtk-driver
```

Running the suite:

```bash
# 1. Release build with the E2E hook enabled (only needed after frontend / Rust changes)
VITE_E2E=1 pnpm tauri build --no-bundle

# 2. Start tauri-driver (port 4444, spawns WebKitWebDriver on 4445)
tauri-driver --port 4444 &

# 3. Full suite …
pnpm test:e2e

# … or a single spec
pnpm test:e2e --spec ./e2e/specs/search.spec.ts
```

`VITE_E2E=1` exposes a `window.__e2e__` hook so specs can bypass native pickers, drive stores directly, and inject text into CodeMirror. It's tree-shaken out of non-E2E builds. Current surface:

| Hook | Purpose |
| --- | --- |
| `loadVault(path)` / `switchVault(path)` / `closeVault()` | Vault lifecycle without the native file picker |
| `pushToast(variant, message)` | Exercise the toast renderer from async failure paths |
| `startProgress` / `updateProgress` / `finishProgress` | Drive the indexing-progress overlay deterministically |
| `typeInActiveEditor(text)` | Dispatch a CM6 transaction — WebKit driver keystrokes don't reach contenteditable |

Three specs are `describe.skip` with inline rationale: `drag-drop` (WebKit can't carry `DataTransfer.setData` across synthetic events), `local-graph` (panel built but not mounted in the current layout), `index-repair` (needs a Rust-side hook to poison the Tantivy index).

## Contributing

PRs welcome. Run `pnpm test` and `pnpm typecheck` before submitting.

## License

MIT — see [LICENSE](LICENSE).

---

*Built with 🦀 by people who think Electron is a subatomic particle, not an app framework.*
