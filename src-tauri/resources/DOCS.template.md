# Vaultcore — User Documentation

Welcome to Vaultcore. This page is bundled with the app and regenerated on every upgrade. It covers every user-visible feature with short examples. For personal notes, use the Home canvas (`.vaultcore/home.canvas`) or any regular note — **edits to this file will be overwritten by the next upgrade**.

---

## Table of contents

- [Getting started](#getting-started)
- [Editor](#editor)
- [Links and embeds](#links-and-embeds)
- [Frontmatter and properties](#frontmatter-and-properties)
- [Templates and the expression language](#templates-and-the-expression-language)
- [Tabs and splits](#tabs-and-splits)
- [Sidebar panels](#sidebar-panels)
- [Canvas](#canvas)
- [Graph view](#graph-view)
- [Search and autocomplete](#search-and-autocomplete)
- [Daily notes](#daily-notes)
- [Bookmarks](#bookmarks)
- [Export](#export)
- [Reading mode](#reading-mode)
- [Command palette](#command-palette)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Storage layout](#storage-layout)
- [Performance notes](#performance-notes)
- [Troubleshooting](#troubleshooting)

---

## Getting started

On first launch, Vaultcore prompts you to pick a vault folder. A vault is any directory on disk — Vaultcore indexes every `.md` file it finds, builds a link graph, a tag index, and a full-text search index, and keeps them in sync as you edit.

Opening another vault: use the app menu entry, or relaunch and pick a different folder. The most recent vault opens automatically on launch.

Vaultcore never modifies files you don't touch. State the app maintains (bookmarks, the home canvas, this docs page) lives in a `.vaultcore/` subdirectory inside the vault; it is ignored by the file tree, link graph, backlinks, and search.

---

## Editor

The editor is based on CodeMirror 6. It runs in two modes on the same underlying text: **edit mode** (the default, WYSIWYG-ish live preview) and **reading mode** (fully rendered). Both operate on the same file on disk — there is no separate "view" format.

**Auto-save.** Every 2 seconds, if the document has changed since the last write, the file is saved in-place. There is no dirty indicator and no manual save shortcut — the file on disk is always within ~2s of what you see.

**Live preview.** Markdown markup characters (emphasis `*`, strong `**`, strike `~~`, inline code `` ` ``, heading `#`, etc.) are hidden on every line where the cursor is **not** currently placed. Moving the cursor onto a line reveals the markup so you can edit it precisely. This applies everywhere except inside the frontmatter block, where markup is always literal.

**GitHub-flavored Markdown.** Supported:

- Headings `#` through `######`
- Emphasis `*italic*`, `_italic_`, `**bold**`, `__bold__`, `~~strikethrough~~`
- Inline code `` `code` `` and fenced code blocks with language identifiers:

  ````
  ```ts
  function hello(): string { return "world"; }
  ```
  ````

- Ordered lists `1.`, unordered lists `-` or `*`
- Task lists `- [ ]` / `- [x]` — toggleable with a click in edit mode
- Tables (GFM pipe syntax):

  ```
  | Column | Value |
  | ------ | ----- |
  | foo    | 1     |
  ```

- Blockquotes `>` (including multi-line and nested)
- Horizontal rules `---`
- Inline HTML (passes through the renderer unchanged)

**Callouts.** Obsidian-style callout blocks render with a coloured bar and icon:

```
> [!note] Title
> Body goes here, as many lines as you want.
```

Supported callout types include `note`, `tip`, `warning`, `danger`, `info`, `quote`, `abstract`, `example`, `question`, `success`, `failure`.

**Fenced code blocks** render with syntax highlighting when the language identifier is known (TypeScript, JavaScript, Rust, Python, JSON, YAML, HTML, CSS, Markdown, shell, SQL, and many more via CodeMirror's language-data registry).

**Image attachments.** Drag an image into the editor, or paste one from the clipboard, and Vaultcore saves it under the vault's attachment folder and inserts a Markdown image link. Image files can also be dropped onto a tab to open them in a read-only image viewer.

**Inline HTML.** Raw HTML tags are preserved and rendered. Use sparingly — Markdown syntax inside an HTML block is not processed.

---

## Links and embeds

**Wiki-links.** `[[Note Name]]` links to another note by filename (without `.md`). Start typing inside `[[` to open a fuzzy-matching autocomplete popup — matches come from the Rust backend using the [nucleo](https://github.com/helix-editor/nucleo) fuzzy matcher, the same engine as the quick switcher.

Aliases: `[[Note Name|Custom Label]]` renders as "Custom Label" but links to `Note Name`. Aliases declared in a note's `aliases` frontmatter key also surface in autocomplete — matching `alias → filename` is shown so you understand why a non-matching filename surfaced.

Click a wiki-link to open the target note in the current tab. Cmd/Ctrl+click opens in a new tab.

**Embeds.** `![[Note Name]]` embeds the full contents of another note inline, rendered as if the body were part of the current document. Useful for transclusions — edit the source note and every embed updates automatically. Embeds also work inside the canvas.

**Backlinks.** Every note tracks which other notes link to it. Open the backlinks panel from the right sidebar (default shortcut: `Cmd/Ctrl+Shift+B`) to see the list for the active note. Click a backlink to jump to the source.

---

## Frontmatter and properties

Frontmatter is a YAML block delimited by `---` at the top of a note:

```
---
title: My note
tags: [project, active]
draft: true
---
```

**Supported syntax:**

- Flat top-level `key: value` pairs only. Nested maps are not parsed.
- Values are either scalars (`title: hello`) or lists. Lists can be flow (`tags: [a, b, c]`) or block:

  ```
  tags:
    - a
    - b
  ```

  Empty flow lists `[]` are also supported.

- Keys match `[A-Za-z_][\w-]*`.
- Entries with `,`, `[`, `]`, `"`, leading/trailing whitespace, or empty values are quoted automatically on save.

**Properties panel.** The Properties panel shows the frontmatter as a structured form with typed inputs. Edits round-trip back to YAML preserving scalar vs. list style.

**Performance.** Only the first ~16 KB of a document is scanned for frontmatter detection — keeps per-keystroke plugin costs bounded on large files.

---

## Templates and the expression language

Templates are plain `.md` files stored under `.vaultcore/templates/` inside the vault. Insert one via **Insert template** (default: `Cmd/Ctrl+Shift+T`) — a picker opens, fuzzy-match the filename, and the rendered template is inserted at the cursor.

### Legacy tokens

```
{{date}}   → 2026-04-20
{{time}}   → 14:07
{{title}}  → the active note's title (filename without .md)
```

### Expression language

Any other `{{ ... }}` body is a live expression evaluated against the `vault` API. Examples:

```
{{vault.name}}
{{vault.path}}
{{vault.notes.count()}}
{{vault.stats.noteCount}}
{{vault.tags.first().name}}

{{vault.notes.where(n => n.property.draft == true).select(n => n.name).toArray()}}

{{vault.notes.sortBy(n => n.name).take(5).select(n => n.title).toArray()}}
```

The language is a safe, allowlisted subset of JavaScript. **No `eval`, no access to globals, no prototype escape** — identifiers resolve only against the vault API or lambda params you introduce.

#### Root API

| Path | Type | Description |
| ---- | ---- | ----------- |
| `vault.name` | string | Vault folder name |
| `vault.path` | string | Absolute vault path |
| `vault.notes` | Collection\<Note\> | All notes in the vault |
| `vault.folders` | Collection\<Folder\> | All folders |
| `vault.tags` | Collection\<Tag\> | All tags |
| `vault.bookmarks` | Collection\<Note\> | Bookmarked notes |
| `vault.stats` | VaultStats | `noteCount`, `tagCount` |

#### Note members

- `name` — filename (e.g. `Ideas.md`)
- `path` — vault-relative path
- `title` — filename without `.md`
- `property.*` — frontmatter keys (dynamic)
- `content` — raw Markdown of the note

#### Folder members

- `name` — folder name (last path segment)
- `path` — vault-relative folder path
- `notes` — `Collection<Note>` of every note under this folder (recursive, includes descendants)

Example: all notes in the `Done` folder, regardless of depth:

```
{{vault.folders.where(f => f.name == "Done").first().notes.count()}}
```

#### Collection methods

Lazy where possible — `first()` and `any()` short-circuit without materializing the whole collection.

| Method | Returns | Notes |
| ------ | ------- | ----- |
| `where(n => bool)` | Collection\<T\> | Filter |
| `select(n => U)` | Collection\<any\> | Project |
| `sortBy(n => key, "asc"\|"desc")` | Collection\<T\> | Order (default asc) |
| `take(n)` | Collection\<T\> | Keep first n |
| `skip(n)` | Collection\<T\> | Drop first n |
| `distinct()` | Collection\<T\> | Deduplicate |
| `first()` | T \| null | First element or null |
| `count()` | number | Size |
| `any(pred?)` | boolean | Any element matches |
| `all(pred)` | boolean | Every element matches |
| `groupBy(n => key)` | any | Group by key |
| `toArray()` | any[] | Materialize |

#### Operators

Arithmetic `+ - * / %`, comparison `== != === !== < <= > >=`, logical `&& || !`, ternary `cond ? a : b`, string concatenation via `+`.

#### Live rendering

Any `{{ ... }}` expression typed directly into a note renders **live in the editor**: the expression is replaced with its evaluated value as soon as the cursor leaves the range. Move the cursor back inside to edit the expression. The rendered value updates automatically when the vault changes (notes added, tags updated, bookmarks toggled).

Evaluation errors (unknown identifier, parse error, runtime error) leave the source text visible — you always see the expression you typed.

#### IDE-style autocomplete

Inside any `{{ ... }}` block, press a `.` or trigger autocomplete manually (`Ctrl+Space`) to see the allowlisted members of the current type:

- After `{{vault.` → `name`, `path`, `notes`, `folders`, `tags`, `bookmarks`, `stats`
- After `{{vault.notes.` → Collection methods (`where`, `select`, `count`, ...)
- After `{{vault.notes.first().property.` → actual frontmatter keys from the active note
- Inside a lambda (`vault.notes.where(n => n.`) → Note members

Suggestions come from the same descriptor tree the evaluator uses — new methods or properties on the vault API show up automatically.

---

## Tabs and splits

Vaultcore uses a multi-tab editor. Each tab owns its own editor view, selection, undo history, and pinned state. Closing a tab preserves the file on disk.

**Tab kinds:**

- Regular file tabs (Markdown, text)
- Graph tab
- Canvas tabs
- Image preview tabs (read-only, for `.png`, `.jpg`, `.svg`, etc.)
- Unsupported-file preview (for binaries)
- Home canvas (per vault)
- Docs (this page)

**Navigation.**

- `Cmd/Ctrl+O` — quick switcher (fuzzy match over all notes)
- `Cmd/Ctrl+Tab` — cycle to next tab
- `Cmd/Ctrl+W` — close active tab
- `Cmd/Ctrl+Shift+Tab` — previous tab (if bound by your OS)

**Active-tab reveal.** When you activate a tab, the sidebar file tree automatically scrolls the corresponding file into view and highlights it.

---

## Sidebar panels

The left sidebar hosts the file tree, tag panel, and bookmarks. The right sidebar (toggleable) hosts backlinks.

**File tree.** Shows the vault folder structure. Click a folder to expand; click a file to open it. Right-click (or long-press on touch) for a context menu with rename, delete, move, and reveal operations. The tree is lazy: only expanded folders are walked, keeping the initial render cheap on large vaults.

**Tag panel.** Lists every unique tag in the vault with its usage count. Click a tag to open a filtered view of notes containing it.

**Bookmarks panel.** Shows the list of bookmarked note paths. Drag to reorder. Toggle a bookmark on the active note with `Cmd/Ctrl+D`.

**Backlinks panel.** Shows every note that links to the active one, with the line number and surrounding context. Click an entry to jump.

**Sidebar width** is persisted across sessions. Drag the resize handle to adjust.

**Toggle shortcuts:** `Cmd/Ctrl+\` or `Cmd/Ctrl+Shift+E` — toggle the left sidebar. `Cmd/Ctrl+Shift+B` — toggle backlinks panel.

---

## Canvas

A canvas is a spatial arrangement of text nodes, note embeds, and connections, stored as a `.canvas` JSON file. Create one via **File: New canvas** (`Cmd/Ctrl+Shift+C`).

Canvas features:

- Text nodes — plain text or Markdown, freely positioned
- Note embeds — full rendered content of another note, live
- Links between nodes
- Pan and zoom
- Per-node resize

Wiki-links inside canvas text nodes and embeds resolve exactly like wiki-links in regular notes.

The **home canvas** (`.vaultcore/home.canvas`) is a per-vault landing page you can open with `Cmd/Ctrl+Shift+H`. It's a regular canvas — edit freely, your changes persist.

---

## Graph view

Opens with `Cmd/Ctrl+Shift+G`. Visualizes the note-link graph as a force-directed layout: each note is a node, each wiki-link is an edge.

- Click a node to open that note
- Drag to reposition
- Scroll to zoom
- Pinch/drag to pan

**Performance.** The graph simulation pauses when the tab is hidden (window in background, switched to another tab). It resumes immediately on refocus. Large vaults render lazily — only nodes in the visible viewport participate in force computation.

---

## Search and autocomplete

**Quick switcher** (`Cmd/Ctrl+O`). Type to fuzzy-match note filenames. Arrow keys to navigate, Enter to open. Alias-declaring notes match on alias too — the match is shown as `alias → filename`.

**Full-text search** (`Cmd/Ctrl+Shift+F` or `Cmd/Ctrl+F`). Opens a dedicated search tab backed by a Tantivy index. Supports phrase queries, boolean operators, and field filters. Results show a snippet and line number per hit.

**Wiki-link autocomplete** — type `[[` in the editor; suggestions come from the nucleo fuzzy matcher over vault filenames and aliases. Alias hits surface as `alias → filename`.

**Tag autocomplete** — type `#` at a word boundary to suggest existing tags. More-used tags rank higher when prefixes tie.

**Template autocomplete** — see the [templates section](#templates-and-the-expression-language).

---

## Daily notes

`Cmd/Ctrl+Shift+D` opens today's daily note, creating it if it doesn't exist. The date format and target folder follow the app settings. Daily notes are regular `.md` files — nothing special about them except the convenience of the shortcut.

---

## Bookmarks

`Cmd/Ctrl+D` toggles a bookmark on the active note. The bookmarks list persists to `.vaultcore/bookmarks.json` and is shown in the Bookmarks sidebar panel. Drag to reorder.

---

## Export

- **Export as HTML** — renders the active note to standalone HTML (with inlined styles) and prompts for a save location.
- **Export as PDF** — renders the active note to PDF (via the HTML pipeline under the hood).

Both commands are available from the command palette.

---

## Reading mode

`Cmd/Ctrl+E` toggles the active tab between edit mode and a fully-rendered reading mode. In reading mode, Markdown markup is invisible, wiki-links become clickable anchors, and the document reads like a published page.

---

## Command palette

`Cmd/Ctrl+P` opens the command palette. Fuzzy-type the name of any action: insert template, open graph, toggle sidebar, export note, and every other command in the app. Every shortcut-bound command also shows up here, making the palette a complete self-discovery surface.

---

## Keyboard shortcuts

Default bindings (use `Cmd` on macOS, `Ctrl` on Windows/Linux):

| Shortcut | Action |
| -------- | ------ |
| `Cmd/Ctrl+N` | New note |
| `Cmd/Ctrl+Shift+C` | New canvas |
| `Cmd/Ctrl+O` | Quick switcher |
| `Cmd/Ctrl+F` | Full-text search |
| `Cmd/Ctrl+Shift+F` | Full-text search (alternate) |
| `Cmd/Ctrl+Shift+B` | Toggle backlinks panel |
| `Cmd/Ctrl+\` | Toggle sidebar |
| `Cmd/Ctrl+Shift+E` | Toggle sidebar (alternate) |
| `Cmd/Ctrl+Tab` | Next tab |
| `Cmd/Ctrl+W` | Close tab |
| `Cmd/Ctrl+Shift+G` | Open graph view |
| `Cmd/Ctrl+Shift+H` | Open home canvas |
| `Cmd/Ctrl+Shift+/` | Open this docs page |
| `Cmd/Ctrl+P` | Command palette |
| `Cmd/Ctrl+D` | Toggle bookmark on active note |
| `Cmd/Ctrl+Shift+D` | Open today's daily note |
| `Cmd/Ctrl+E` | Toggle reading mode |
| `Cmd/Ctrl+Shift+T` | Insert template |

The command palette (`Cmd/Ctrl+P`) is the source of truth — if a shortcut above ever falls out of sync, the palette shows the live binding.

---

## Settings

Accessible from the app menu.

- **Theme.** Light / dark / follow-system.
- **Accent colour.** Per-vault.
- **Font family.** Editor fonts (Inter, Lora, Fira Code, JetBrains Mono are bundled).
- **Sidebar width.** Persisted automatically as you resize.

---

## Storage layout

Everything Vaultcore writes lives under `.vaultcore/` inside the vault:

```
<vault>/
├── <your notes>.md
├── <your folders>/
└── .vaultcore/
    ├── home.canvas         Per-vault home landing page
    ├── DOCS.md             This docs file (regenerated on upgrade)
    ├── bookmarks.json      Bookmarked note paths
    └── templates/          Template .md files (user-editable)
```

The `.vaultcore/` directory is skipped by the file tree, link graph, backlinks, full-text search, and tag index. Wiki-links from inside `.vaultcore/` files still resolve **outward** to regular vault notes — resolution is target-based, not source-based.

---

## Performance notes

Vaultcore targets a ≤ 16 ms frame budget on typical operations, even on large vaults.

- **Frontmatter detection** is capped at the first ~16 KB of the document per keystroke. Frontmatter blocks longer than that are rare; the cap keeps CodeMirror plugin updates cheap.
- **Graph simulation** pauses when the graph tab is hidden (window background, another tab active). Resumes on refocus with no manual step.
- **File tree** is lazy — only expanded folders are walked. Cold open of a 100k-note vault completes in a few hundred milliseconds.
- **Indexing** is incremental: after the first full index, only files whose content hash changed are re-parsed on subsequent changes.
- **Autocomplete popups** (wiki-links, tags) run against cached in-memory data — no IPC round-trip per keystroke for tags.

---

## Troubleshooting

**Vault folder is unreachable** (e.g. unmounted external drive or deleted path). The app detects the condition on the next filesystem probe and shows an inline banner. Reconnect the drive / restore the folder and reopen the vault.

**A file edit isn't saving.** Auto-save runs on a 2-second interval. If a file is open in another app with an exclusive lock, writes may fail silently — close the other app and re-focus Vaultcore to retry.

**A template insertion shows `{{!err: ...}}` placeholders.** The expression couldn't be evaluated — the error message tells you why (unknown identifier, parse error, runtime error). Fix the expression, delete the placeholder, or remove it from the template.

**Autocomplete popup is missing.** Make sure autocomplete is enabled (default). Press `Ctrl+Space` to trigger manually. For `{{ ... }}` autocomplete specifically, the cursor must be inside an open template block with no `}}` between the `{{` and your position.

**Application logs** are written to the platform's standard log directory. Check them when reporting issues.

---

*This documentation is regenerated on every Vaultcore version upgrade. If you want to annotate or extend it, copy the relevant sections into a regular note in your vault.*
