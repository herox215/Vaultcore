# Phase 4: Links - Research

**Researched:** 2026-04-12
**Domain:** Wiki-link graph, CM6 decorations/autocomplete, Rust link-graph data structure, rename-cascade
**Confidence:** HIGH — all key claims verified against codebase or official package APIs

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Backlinks Panel (LINK-06)**
- D-01: Backlinks live in a dedicated right sidebar — a new layout column to the right of the editor. Not a left-sidebar tab, not a bottom panel.
- D-02: Right sidebar is toggled via keyboard shortcut (e.g., Cmd/Ctrl+Shift+B). Closed by default. Open/closed state persisted across sessions.
- D-03: Each backlink entry shows filename as title + 1-2 lines of context around the `[[link]]`. Clicking an entry opens that note in the editor.

**Link Autocomplete (LINK-05)**
- D-04: Autocomplete popup shows filename (bold) + relative path (grey) per entry.
- D-05: Filtering uses fuzzy matching (nucleo, same engine as Quick Switcher Cmd+P).
- D-06: Alias syntax supported — after selecting a file, typing `|` allows entering alias freetext. Produces `[[Note|alias]]`.

**Unresolved-Link Styling (LINK-04)**
- D-07: Resolved links rendered in accent color (blue/purple, clickable). Unresolved links rendered in muted/grey color.
- D-08: Clicking an unresolved link creates the note and opens it in a new tab. Obsidian-style "click to create" workflow.

**Rename-Cascade (LINK-09)**
- D-09: Confirmation dialog: "X Links in Y Dateien werden aktualisiert. Fortfahren?" with [Abbrechen] / [Aktualisieren].
- D-10: Error handling: partial update + toast. Successfully rewritten links persist; failed files reported via toast.
- D-11: Rename-cascade triggers on both rename and move (including drag-and-drop).

### Claude's Discretion
- CM6 extension architecture for wiki-link parsing/decoration (ViewPlugin vs. Decoration approach)
- Link graph data structure in Rust (adjacency list, HashMap, etc.)
- Incremental link graph update strategy on file changes
- `get_unresolved_links` command implementation details
- Right sidebar width, resize behavior, animation

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LINK-01 | `[[Note]]` and `[[Note\|alias]]` parsed and rendered as clickable wiki-links in CM6 | ViewPlugin + Decoration.mark() pattern; lezer markdown tree provides parse anchor |
| LINK-02 | 3-stage shortest-path resolution: same folder → shortest relative path → alpha tiebreak | Rust `link_graph` module; spec Section 6.6 defines exact algorithm |
| LINK-03 | Clicking a resolved wiki-link opens the target note in a new tab | `tabStore.openTab()` already exists; CM6 click handler via `EditorView.domEventHandlers` |
| LINK-04 | Unresolved wiki-links visually distinct (different color); click creates note + opens tab | ViewPlugin reads resolution state from backend; `createFile` IPC already exists |
| LINK-05 | Typing `[[` opens autocomplete list with fuzzy filename matching | `autocompletion()` extension already in package.json; `suggest_links` backed by nucleo |
| LINK-06 | Backlinks panel shows every note linking to the active note | New `BacklinksPanel.svelte` in right sidebar; `get_backlinks` command; active-note subscription |
| LINK-07 | `get_unresolved_links` command returns all dangling links in vault | Rust: iterate `link_graph.outgoing`, collect unresolved entries |
| LINK-08 | Link graph built on startup (adjacency list) and updated incrementally on file changes | New `LinkGraph` struct added to `VaultState`; watcher `file_changed` events trigger updates |
| LINK-09 | Renaming a file updates every wiki-link after confirmation dialog | `update_links_after_rename` command; extends existing `pendingRename` flow in `TreeNode.svelte` |
</phase_requirements>

---

## Summary

Phase 4 delivers the full wiki-link graph for VaultCore. The work has three parallel tracks: (1) a Rust `link_graph` module that parses wiki-links at indexing time, stores an adjacency list, and exposes IPC commands for backlinks/unresolved/rename-cascade; (2) a set of CM6 extensions in TypeScript that decorate `[[links]]` in the editor, handle click navigation, and trigger `[[` autocomplete; (3) a new right-sidebar panel in Svelte for the backlinks view.

The codebase from Phases 1-3 is well-prepared. The `FileIndex` and `nucleo` matcher are already in place. The `IndexCoordinator` pattern (mpsc queue, shared Arcs) is the exact shape needed for `LinkGraph`. The `tabStore.openTab()` and `createFile` IPC calls needed for link-click navigation already exist. `TreeNode.svelte` already has the `pendingRename` state and confirmation dialog UI — it just needs to call a new cascade command instead of doing nothing with the count.

The largest unknowns are (a) the CM6 ViewPlugin architecture for wiki-link decoration (must integrate with the lezer markdown parse tree to avoid false positives in code blocks/front matter) and (b) the rename-cascade which must scan and rewrite every file in the vault — a potentially expensive operation that needs to run off the main thread.

**Primary recommendation:** Implement in this order — Rust `LinkGraph` + IPC commands first (they are pure Rust, testable in isolation), then CM6 decoration/click extension, then `[[` autocomplete, then backlinks panel, then rename-cascade last (most complex, touches most files).

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@codemirror/view` | 6.41.0 (installed) | `ViewPlugin`, `Decoration.mark()`, `EditorView.domEventHandlers` for wiki-link render/click | Already installed; CM6 standard extension mechanism |
| `@codemirror/autocomplete` | 6.20.1 (installed) | `autocompletion()` extension + `CompletionSource` for `[[` popup | Already installed; the same package providing `closeBrackets` |
| `@codemirror/state` | 6.6.0 (installed) | `StateField`, `Compartment` for link resolution state | Already installed |
| `regex` crate | 1.x (in Cargo.toml) | Wiki-link extraction regex in Rust during indexing | Already added in Phase 2 for `count_wiki_links` |
| `rayon` crate | 1.x (in Cargo.toml) | Parallel rename-cascade file rewriting | Already installed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `nucleo-matcher` | 0.3 (installed) | Fuzzy matching for `[[` autocomplete (reuse from Quick Switcher) | Autocomplete source filters via nucleo pattern |
| `walkdir` | 2.x (installed) | Walk vault for rename-cascade target files | Already installed for indexing |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ViewPlugin` + lezer tree walk | `MatchDecorator` regex scan | `MatchDecorator` is simpler but can't exclude code fences; lezer tree walk is required to avoid false positives in code blocks |
| Custom regex wiki-link parser in Rust | `pulldown-cmark` AST | pulldown-cmark does not emit wiki-link events; a dedicated regex over the raw text is simpler and correct for this narrow use case |

**Installation:** No new packages needed. All dependencies are already in `package.json` and `Cargo.toml`.

---

## Architecture Patterns

### Recommended Project Structure (additions)

```
src-tauri/src/
├── commands/
│   └── links.rs           # NEW: get_backlinks, get_outgoing_links,
│                          #      get_unresolved_links, suggest_links,
│                          #      update_links_after_rename
├── indexer/
│   ├── link_graph.rs      # NEW: LinkGraph struct, parser, resolution algorithm
│   └── mod.rs             # EXTEND: add LinkGraph to IndexCoordinator

src/
├── components/
│   ├── Editor/
│   │   ├── wikiLink.ts    # NEW: CM6 ViewPlugin for [[link]] decoration + click
│   │   └── extensions.ts  # EXTEND: add wikiLinkPlugin, autocompletion()
│   └── Layout/
│       ├── VaultLayout.svelte  # EXTEND: 3→5 column grid, right sidebar toggle
│       └── BacklinksPanel.svelte  # NEW: right sidebar backlinks UI
├── store/
│   └── backlinksStore.ts  # NEW: tracks active-file backlinks, right-sidebar open state
├── ipc/
│   └── commands.ts        # EXTEND: add getBacklinks, getUnresolvedLinks,
│                          #         suggestLinks, updateLinksAfterRename
```

### Pattern 1: Rust LinkGraph — Adjacency List in VaultState

**What:** A `LinkGraph` struct stored as `Arc<Mutex<LinkGraph>>` in `VaultState`, alongside the existing `FileIndex`. Populated during `index_vault`, updated incrementally via `IndexCmd` messages.

**When to use:** Anytime backlinks, outgoing links, or unresolved links are queried.

```rust
// Source: spec Section 8.1 data model + codebase pattern from indexer/mod.rs

/// Outgoing link from a source file.
pub struct ParsedLink {
    pub target_raw: String,       // Raw text inside [[...]], before alias
    pub alias: Option<String>,    // Text after | in [[target|alias]]
    pub line_number: u32,
    pub context: String,          // 1-2 lines around the link for backlinks panel
}

pub struct LinkGraph {
    /// source_rel_path → outgoing links (raw, unresolved)
    pub outgoing: HashMap<String, Vec<ParsedLink>>,
    /// target_rel_path (resolved) → source_rel_paths
    pub incoming: HashMap<String, Vec<String>>,
}

impl LinkGraph {
    pub fn new() -> Self { ... }
    pub fn update_file(&mut self, source_rel: &str, links: Vec<ParsedLink>,
                       file_index: &FileIndex, vault_root: &str) { ... }
    pub fn remove_file(&mut self, source_rel: &str) { ... }
    pub fn get_backlinks(&self, target_rel: &str) -> Vec<BacklinkEntry> { ... }
    pub fn get_unresolved(&self) -> Vec<UnresolvedLink> { ... }
}
```

**Key design:** `update_file` takes the raw links from the file, resolves them using the 3-stage algorithm against `FileIndex.all_relative_paths()`, and rebuilds both `outgoing` and `incoming` for that source file. The `incoming` map is keyed by resolved relative path — so it can answer backlink queries in O(1).

### Pattern 2: 3-Stage Shortest-Path Resolution

**What:** The Obsidian-compatible resolution algorithm. Given a raw link target (e.g., `"Notiz"`) and the source file's folder, find the best match among all vault relative paths.

**Algorithm (spec Section 6.6):**

```rust
// Source: VaultCore_MVP_Spezifikation_v3.md Section 6.6 [VERIFIED: codebase]
fn resolve_link(
    target_raw: &str,          // e.g. "Notiz" or "subfolder/Notiz"
    source_folder: &str,       // vault-relative folder of the source file
    all_rel_paths: &[String],  // from FileIndex
) -> Option<String> {
    let target_stem = target_raw.trim_end_matches(".md");

    // Stage 1: exact filename match in same folder
    let same_folder_match = all_rel_paths.iter().find(|p| {
        let stem = path_stem(p);
        let folder = path_folder(p);
        stem == target_stem && folder == source_folder
    });
    if let Some(p) = same_folder_match { return Some(p.clone()); }

    // Stage 2 + 3: all files whose stem matches, pick shortest relative path,
    // alphabetical tiebreak
    let mut candidates: Vec<&String> = all_rel_paths.iter()
        .filter(|p| path_stem(p) == target_stem)
        .collect();

    // "Shortest relative path" = fewest path segments from source folder
    candidates.sort_by_key(|p| (relative_distance(source_folder, p), *p));
    candidates.into_iter().next().cloned()
}
```

### Pattern 3: CM6 Wiki-Link ViewPlugin

**What:** A `ViewPlugin` that walks the visible document, finds `[[...]]` spans using a regex or lezer tree, and applies `Decoration.mark()` with CSS classes. Handles click events via `EditorView.domEventHandlers`.

**When to use:** This is the extension that drives LINK-01, LINK-03, LINK-04.

```typescript
// Source: CM6 docs [VERIFIED: node_modules/@codemirror/view/dist/index.d.ts]
// Pattern from CM6 official "decoration" example

import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

export function wikiLinkPlugin(
  resolveLink: (target: string) => boolean,  // true = resolved
  onLinkClick: (target: string, resolved: boolean) => void,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, resolveLink);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, resolveLink);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e: MouseEvent, view: EditorView) {
          // resolve target from click position, call onLinkClick
        },
      },
    }
  );
}
```

**Critical detail — lezer tree exclusion:** The regex must be applied only to positions where the lezer syntax tree does NOT mark the node as `FencedCode`, `InlineCode`, or `CodeBlock`. Use `syntaxTree(view.state).resolve(pos)` to check node type before applying decoration. This prevents `[[links]]` inside code blocks from being decorated.

**Critical detail — CM6 Decoration ordering:** `RangeSetBuilder` requires ranges to be added in document order (sorted by `from` position). Sort regex matches before adding them.

### Pattern 4: CM6 `[[` Autocomplete via CompletionSource

**What:** A `CompletionSource` registered with the `autocompletion()` extension that triggers when the user types `[[`.

```typescript
// Source: @codemirror/autocomplete API [VERIFIED: node_modules dist/index.d.ts]

import { autocompletion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { searchFilename } from "../../ipc/commands";  // reuse existing IPC

const wikiLinkCompletionSource = async (
  ctx: CompletionContext
): Promise<CompletionResult | null> => {
  // Only trigger after [[
  const match = ctx.matchBefore(/\[\[([^\]]*)/);
  if (!match) return null;

  const query = match.text.slice(2); // strip [[
  const results = await searchFilename(query, 20);  // nucleo, already wired

  return {
    from: match.from + 2,  // replace from after [[
    options: results.map((r) => ({
      label: basename(r.path),
      detail: r.path,        // grey relative path (D-04)
      apply: `${basename(r.path)}]]`,
    })),
  };
};
```

**D-06 alias support:** When the user types `|` after selecting a file, the popup has already closed (by completing). The `|` is freehand — no additional popup logic needed. The `apply` string ends with `]]` (no `|`), and the user types `|alias]]` manually if desired. Alternatively, `apply` can be a function that places cursor inside `[[target|]]` and moves cursor to alias position using CM6 snippet syntax — this would be cleaner. Either approach satisfies D-06.

### Pattern 5: Incremental LinkGraph Update on File Change

**What:** The watcher already emits `vault://file_changed` events (create/modify/delete/rename). The frontend listens and calls backend IPC to re-index changed files (Phase 3 already does this for Tantivy). LinkGraph must be updated in the same flow.

**Approach:** Add `IndexCmd::UpdateLinks { path, content }` and `IndexCmd::RemoveLinks { path }` to the existing mpsc queue. When the background task processes these, it re-parses links from `content`, calls `link_graph.update_file()` or `link_graph.remove_file()`. The `link_graph` Arc is shared so commands can read from it synchronously.

**Key constraint (PERF-10):** incremental single-file update < 5 ms. Parsing wiki-links from a ~500-word file with a regex is O(content_len) — comfortably sub-millisecond. Updating the adjacency list is O(links_in_file). No full rescan needed.

### Pattern 6: Rename-Cascade Implementation

**What:** `update_links_after_rename` command receives `old_rel_path` and `new_rel_path`. It must:
1. Find all files in vault whose content contains `[[OldStem]]` or `[[OldStem|...]]`
2. Rewrite those files atomically (read, replace, write)
3. Update `link_graph` for each modified file
4. Return count of updated files / list of failures

**Threading:** Use `rayon::par_iter()` over candidate files for parallel rewriting. The `write_ignore` list must record each written path before writing. Already available in `VaultState`.

**Regex for rewrite:**

```rust
// Source: count_wiki_links_impl in src-tauri/src/commands/files.rs [VERIFIED: codebase]
// Extend the existing pattern to also match aliases:
let pattern = format!(
    r"\[\[{stem}(?:\|[^\]]*)?(?:/[^\]]+)?\]\]",
    stem = regex::escape(old_stem)
);
// Replace with new stem, preserving alias:
// [[OldNote]] → [[NewNote]]
// [[OldNote|alias]] → [[NewNote|alias]]
```

**Error handling (D-10):** Collect `Vec<(path, io::Error)>` failures. After all iterations complete, persist successes, return failure list to frontend. Frontend shows partial-update toast.

### Pattern 7: Right Sidebar — CSS Grid Extension

**What:** VaultLayout.svelte currently uses `grid-template-columns: var(--sidebar-width) auto 1fr`. Extend to 5-column: `var(--sidebar-width) auto 1fr auto var(--right-sidebar-width)`.

**State:** `rightSidebarOpen` as `$state(false)`, persisted in `localStorage`. Right sidebar width default 280px (same proportions as left). Toggle via Cmd/Ctrl+Shift+B — add to `handleKeydown` in `VaultLayout.svelte`.

```
[left-sidebar][left-divider][editor-area][right-divider][right-sidebar]
```

When `rightSidebarOpen = false`, `--right-sidebar-width: 0` and right divider hidden. Same pattern as the existing left sidebar collapse.

### Anti-Patterns to Avoid

- **Storing EditorView or DecorationSet in Svelte `$state`:** Proxy wrapping breaks CM6 internal field access. RC-01 from Phase 1 applies equally to ViewPlugin instances.
- **Calling `get_backlinks` on every keystroke:** The active file only changes on tab switch or file open. Debounce / only call on tab activation.
- **Building LinkGraph on the frontend:** Link resolution requires the full vault file list. Keep resolution in Rust; frontend only sends raw target strings.
- **Holding Mutex guard across `.await`:** Established pattern — clone Arcs before releasing the guard. The `link_graph` Arc follows the same pattern as `file_index`.
- **Using `Decoration.none` reset on every update:** Build `RangeSetBuilder` from scratch on `docChanged || viewportChanged`, as shown in CM6 examples. Do not attempt to diff the old set.
- **Applying decorations to code block content:** Must check lezer tree node type at each match position to skip `FencedCode` / `InlineCode` spans.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Fuzzy matching for `[[` autocomplete | Custom substring match | `nucleo-matcher` (already installed) + existing `search_filename` IPC | Consistent behavior with Quick Switcher; nucleo handles unicode, smart case |
| Wiki-link regex | Custom parser | `regex` crate already in Cargo.toml | Edge cases: aliases, paths with slashes, escaped brackets |
| File walking for rename-cascade | Manual recursion | `walkdir` (already installed) | Handles symlinks correctly per spec (D-05: display but don't follow) |
| Autocomplete popup UI | Custom dropdown | `autocompletion()` from `@codemirror/autocomplete` (already installed) | Keyboard nav, positioning, theming all built-in |
| Parallel file rewriting | Sequential for-loop | `rayon::par_iter()` (already installed) | 100k-note vault rename could touch thousands of files |

**Key insight:** Every library needed for Phase 4 is already installed. Zero new dependencies required.

---

## Common Pitfalls

### Pitfall 1: False Positives in Code Blocks
**What goes wrong:** `[[links]]` inside fenced code blocks or inline code get decorated as wiki-links, confusing users and breaking Obsidian compatibility.
**Why it happens:** A naive regex scan over the full document text ignores syntax structure.
**How to avoid:** After finding a regex match, call `syntaxTree(state).resolve(match.from, 1)` and check that no ancestor node has type `FencedCode`, `CodeBlock`, or `InlineCode`.
**Warning signs:** Links in `` `[[code]]` `` appearing highlighted in tests.

### Pitfall 2: Mutex Guard Held Across `.await`
**What goes wrong:** Rust compiler error: "future cannot be sent between threads safely" or deadlock at runtime.
**Why it happens:** `MutexGuard` is `!Send`. If held across an `.await` point, the compiler rejects it (or it blocks the async runtime if it somehow compiles).
**How to avoid:** Pattern established in Phase 3: clone `Arc` handles before releasing the guard. For `link_graph`: `let lg = Arc::clone(&coord.link_graph); drop(guard);` then `let guard = lg.lock()...`.
**Warning signs:** `error[E0277]: future cannot be sent between threads`.

### Pitfall 3: RangeSetBuilder Out-of-Order Panic
**What goes wrong:** CM6 panics at runtime with "ranges must be added in document order".
**Why it happens:** Regex `find_iter` may yield matches in document order, but if multiple passes or async resolution is involved, order can be lost.
**How to avoid:** Collect all matches into a `Vec`, sort by `from` position, then iterate sorted matches when adding to `RangeSetBuilder`.
**Warning signs:** Editor crash/panic in browser console when opening files with multiple wiki-links.

### Pitfall 4: Link Resolution Stale After File Rename
**What goes wrong:** After renaming `NoteA.md` to `NoteB.md`, the `incoming` map still has entries keyed by `NoteA`'s old resolved path.
**Why it happens:** `update_file` rebuilds outgoing but the `incoming` map accumulates entries from old files.
**How to avoid:** `update_file` must first call `remove_file` for the old resolved path before inserting new entries. `remove_file` removes the source from all `incoming` entries it previously contributed to.
**Warning signs:** Backlinks panel shows ghost entries after rename.

### Pitfall 5: Autocomplete Triggers Inside Already-Complete Links
**What goes wrong:** Typing inside an existing `[[Note]]` re-triggers the autocomplete popup on every character.
**Why it happens:** The `matchBefore` regex for the autocomplete source isn't anchored correctly.
**How to avoid:** The `CompletionSource` must check that there is no closing `]]` between the `[[` and the cursor. Use `ctx.matchBefore(/\[\[[^\]]*/)` — the `[^\]]*` ensures no `]` has been typed yet.
**Warning signs:** Popup appearing while editing the alias text after `|`.

### Pitfall 6: Rename-Cascade Not Triggered on Move (D-11)
**What goes wrong:** Moving a file via drag-and-drop updates the file's path but doesn't update wiki-links pointing to it.
**Why it happens:** The current `handleDrop` in `TreeNode.svelte` calls `moveFile` and refreshes children, but the existing rename confirmation flow (`pendingRename`) is only wired to the rename path.
**How to avoid:** After `moveFile` succeeds, compute the old stem and new stem. If they differ or the resolved path changes, invoke the same cascade confirmation flow. Since move changes shortest-path resolution, link rewriting is always needed.
**Warning signs:** Links become unresolved after drag-and-drop.

### Pitfall 7: Link Count in Confirmation Dialog Using `count_wiki_links` (Wrong)
**What goes wrong:** The existing `count_wiki_links` (used in Phase 2's confirmation dialog) uses a simple regex that matches `[[stem]]` but not `[[stem|alias]]` or `[[folder/stem]]`. It undercounts.
**Why it happens:** The Phase 2 regex was designed for a simpler use case.
**How to avoid:** The rename-cascade confirmation should use the link graph's `incoming` map, not `count_wiki_links`. `get_backlinks(old_stem)` returns the accurate count from the fully-resolved graph. The count in the dialog (D-09) should be from the graph.
**Warning signs:** "0 links will be updated" even though the file has backlinks.

---

## Code Examples

### Wiki-Link Regex (Rust)

```rust
// Source: Extended from count_wiki_links_impl in src-tauri/src/commands/files.rs [VERIFIED]
// Matches: [[target]], [[target|alias]], [[folder/target]], [[folder/target|alias]]
// Capture group 1 = full target (before |), group 2 = alias (after |, optional)
static WIKI_LINK_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]").unwrap()
});

fn extract_links(content: &str, line_offset: u32) -> Vec<ParsedLink> {
    let mut links = Vec::new();
    for (line_num, line) in content.lines().enumerate() {
        for cap in WIKI_LINK_RE.captures_iter(line) {
            links.push(ParsedLink {
                target_raw: cap[1].trim().to_string(),
                alias: cap.get(2).map(|m| m.as_str().to_string()),
                line_number: line_offset + line_num as u32,
                context: line.to_string(),
            });
        }
    }
    links
}
```

### LinkGraph: Add to VaultState and IndexCoordinator

```rust
// Source: Pattern from lib.rs VaultState + indexer/mod.rs [VERIFIED: codebase]
// In lib.rs VaultState:
pub link_graph: Arc<Mutex<LinkGraph>>,

// In IndexCoordinator::new():
let link_graph = Arc::new(Mutex::new(LinkGraph::new()));
// In IndexCoordinator struct:
pub link_graph: Arc<Mutex<LinkGraph>>,
```

### Backlinks IPC Command

```rust
// Source: Pattern from search.rs search_fulltext [VERIFIED: codebase]
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkEntry {
    pub source_path: String,   // vault-relative path of the linking file
    pub source_title: String,  // title from FileIndex
    pub context: String,       // 1-2 lines around [[link]] (D-03)
    pub line_number: u32,
}

#[tauri::command]
pub async fn get_backlinks(
    path: String,              // vault-relative path of target file
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<BacklinkEntry>, VaultError> {
    // Clone Arcs before releasing Mutex (established pattern)
    let (link_graph, file_index) = {
        let guard = state.index_coordinator.lock()...;
        (guard.as_ref()?.link_graph.clone(), guard.as_ref()?.file_index())
    };
    let lg = link_graph.lock()...;
    Ok(lg.get_backlinks(&path, &file_index.lock()...))
}
```

### Frontend: BacklinksStore

```typescript
// Source: Pattern from scrollStore.ts [VERIFIED: codebase]
// Classic svelte/store per D-06/RC-01 — no $state class wrappers
import { writable } from "svelte/store";
import type { BacklinkEntry } from "../types/links";

interface BacklinksStoreState {
  rightSidebarOpen: boolean;
  activeFilePath: string | null;
  backlinks: BacklinkEntry[];
  loading: boolean;
}

export const backlinksStore = {
  subscribe: _store.subscribe,
  toggleSidebar(): void { ... },
  setActiveFile(path: string | null): void { ... },
  // Called after setActiveFile resolves IPC
  _setBacklinks(entries: BacklinkEntry[]): void { ... },
};
```

### CSS Grid Extension (VaultLayout.svelte)

```svelte
<!-- Source: VaultLayout.svelte grid pattern [VERIFIED: codebase] -->
<!-- Extend 3-column to 5-column: -->
<div
  class="vc-vault-layout"
  style="
    --sidebar-width: {sidebarCollapsed ? 0 : sidebarWidth}px;
    --right-sidebar-width: {rightSidebarOpen ? rightSidebarWidth : 0}px;
  "
>
<!-- grid-template-columns in CSS: -->
<style>
  .vc-vault-layout {
    display: grid;
    grid-template-columns:
      var(--sidebar-width, 240px)
      auto
      1fr
      auto
      var(--right-sidebar-width, 0px);
    height: 100vh;
  }
</style>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `MatchDecorator` (regex only) | `ViewPlugin` + lezer tree check | CM6 6.x established | Prevents false positives in code blocks |
| Synchronous link resolution on every keystroke | Resolve once on file open + update on graph change | Established pattern | Meets PERF-08 < 10ms target |
| Full vault rescan on rename | Incremental graph update per file + rayon parallel rewrite | Design decision | Meets PERF-10 < 5ms incremental update |

**Deprecated/outdated:**
- `basicSetup`: Not used in VaultCore (RC-02, Phase 1 decision). Do not import it.
- Storing resolution results in `$state`: Breaks CM6 (RC-01).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Lezer markdown parse tree node types for code blocks are `FencedCode`, `CodeBlock`, `InlineCode` | Architecture Patterns - Pitfall 1 | Wrong node names = code-block exclusion broken; links in code fences get decorated |
| A2 | `nucleo` pattern matching on vault-relative paths stays < 10ms at 100k notes (PERF-08) | Standard Stack | If slower, need client-side pre-filter (limit candidates to cached list before nucleo pass) |
| A3 | `rayon::par_iter()` file rewriting for rename-cascade will be fast enough for large cascades | Common Pitfalls - Pattern 6 | If too slow for multi-thousand-link cascades, need async streaming with progress event |

---

## Open Questions (RESOLVED)

1. **Lezer markdown node names for code exclusion** — **RESOLVED:** Verified at runtime. Plan 04-02 Task 2 step 4 documents the fallback: if `FencedCode`/`InlineCode` aren't correct names, log `node.type.name` during development and adjust. A1 is tagged as a known Wave 0 verification.

2. **Move operation: does shortest-path change require link rewrite?** — **RESOLVED:** D-11 locks cascade on both rename and move. Plan 04-04 Task 2b calls `updateLinksAfterRename(oldRel, newRel)` after every move (drag-drop included), which rewrites the link text to match the new path semantics. No silent resolution shift.

3. **Alias completion UX — snippet vs. plain text** — **RESOLVED:** Option (a) chosen for MVP. Plan 04-03 Task 1 inserts `[[Filename]]` and the user types `|alias` manually. Simpler, no snippet extension testing needed.

---

## Environment Availability

Step 2.6: No new external dependencies identified. All libraries are already installed (verified by `Cargo.toml` and `package.json` reads). Skipping environment audit for tools beyond the project's own codebase.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 (frontend) + Rust built-in test harness (backend) |
| Config file | `vitest.config.ts` (frontend), `cargo test` (backend) |
| Quick run command | `cargo test -p vaultcore_lib link_graph -- --nocapture` (Rust) / `pnpm test` (TS) |
| Full suite command | `cargo test` + `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LINK-01 | Wiki-link parsing extracts target + alias | unit (Rust) | `cargo test link_graph::tests::parse_wiki_links` | ❌ Wave 0 |
| LINK-02 | 3-stage resolution matches Obsidian behavior | unit (Rust) | `cargo test link_graph::tests::resolve_link_*` | ❌ Wave 0 |
| LINK-03 | Click on resolved link calls openTab | unit (TS) | `pnpm test wikiLink` | ❌ Wave 0 |
| LINK-04 | Unresolved link gets muted class; click creates note | unit (TS) | `pnpm test wikiLink` | ❌ Wave 0 |
| LINK-05 | `[[` triggers autocomplete with nucleo results | unit (TS) | `pnpm test wikiLinkAutocomplete` | ❌ Wave 0 |
| LINK-06 | Backlinks panel shows correct sources for active note | unit (Rust) | `cargo test link_graph::tests::get_backlinks` | ❌ Wave 0 |
| LINK-07 | `get_unresolved_links` returns all dangling links | unit (Rust) | `cargo test link_graph::tests::get_unresolved` | ❌ Wave 0 |
| LINK-08 | Incremental update after file change keeps graph consistent | unit (Rust) | `cargo test link_graph::tests::incremental_update` | ❌ Wave 0 |
| LINK-09 | Rename-cascade rewrites correct files, skips failures | unit (Rust) | `cargo test links::tests::rename_cascade` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `cargo test -p vaultcore_lib link_graph` for Rust tasks; `pnpm test` for TS tasks
- **Per wave merge:** `cargo test && pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/indexer/link_graph.rs` — covers LINK-01, LINK-02, LINK-06, LINK-07, LINK-08
- [ ] `src-tauri/src/tests/link_graph.rs` — unit tests for above
- [ ] `src-tauri/src/commands/links.rs` — covers LINK-06, LINK-07, LINK-09
- [ ] `src-tauri/src/tests/links.rs` — unit tests for rename-cascade
- [ ] `src/components/Editor/wikiLink.ts` — covers LINK-01, LINK-03, LINK-04
- [ ] `src/components/Layout/BacklinksPanel.svelte` — covers LINK-06
- [ ] `src/store/backlinksStore.ts` — shared state for right sidebar

---

## Security Domain

Security enforcement is enabled. Phase 4 adds new IPC surface but no network calls.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A (local app) |
| V3 Session Management | no | N/A |
| V4 Access Control | yes | Vault-scope guard (already in Rust commands): `canonicalize → starts_with(vault)` before any read/write |
| V5 Input Validation | yes | Wiki-link target_raw: sanitize before using as filesystem path in resolution. Regex escape before building search pattern (already done in `count_wiki_links`). |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via `[[../../etc/passwd]]` | Tampering | Vault-scope guard: `resolve_link` returns a relative path, resolved absolute path must pass `starts_with(vault_root)` before opening |
| ReDoS via malicious wiki-link content | DoS | Use `regex` crate with a bounded pattern; avoid backtracking-heavy patterns. The current `[^\]]+` pattern is linear. |
| Rename-cascade writing outside vault | Tampering | Same vault-scope guard: each file path written by `update_links_after_rename` must be canonicalized + checked against vault root |
| Link text XSS in backlinks context display | Tampering | Context strings passed to frontend are plain text, not HTML. Svelte `{text}` binding (not `{@html}`) prevents injection. |

---

## Sources

### Primary (HIGH confidence)
- `src-tauri/Cargo.toml` — verified all dependency versions
- `package.json` — verified all frontend dependency versions
- `node_modules/@codemirror/view/dist/index.d.ts` — ViewPlugin, Decoration, DecorationSet API
- `node_modules/@codemirror/autocomplete/dist/index.d.ts` — CompletionSource, autocompletion API
- `src-tauri/src/indexer/mod.rs`, `memory.rs` — IndexCoordinator pattern, FileIndex shape
- `src-tauri/src/commands/files.rs` — count_wiki_links_impl, existing regex pattern
- `src-tauri/src/lib.rs` — VaultState shape, command registration pattern
- `src/components/Editor/extensions.ts` — RC-02 explicit extension list
- `src/components/Layout/VaultLayout.svelte` — 3-column CSS grid, sidebar pattern
- `src/components/Sidebar/TreeNode.svelte` — pendingRename flow, confirmation dialog UI
- `src/ipc/commands.ts` — IPC wrapper pattern, normalizeError
- `src/store/tabStore.ts` — openTab, updateFilePath API
- `src/store/scrollStore.ts` — one-shot store pattern
- `VaultCore_MVP_Spezifikation_v3.md` Section 6.6, 8.1 — link resolution spec, data model

### Secondary (MEDIUM confidence)
- CM6 official decoration pattern (verified structure in installed package types)
- Spec Section 11 Rust backend structure — canonical module naming (`commands/links.rs`, `indexer/link_graph.rs`)

### Tertiary (LOW confidence — marked A1-A3)
- Lezer markdown node type names (A1) — training knowledge, must verify in code
- nucleo 100k performance at autocomplete latency (A2) — known fast from Phase 3 experience but not formally benchmarked for this use case
- Move cascade UX behavior (A3) — Obsidian behavior not directly verified

---

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — all packages verified in installed node_modules and Cargo.toml
- Architecture: HIGH — patterns directly derived from existing codebase; spec algorithm quoted verbatim
- Pitfalls: HIGH — most derived from existing codebase patterns and established decisions (RC-01, RC-02)
- Link resolution algorithm: HIGH — spec Section 6.6 is explicit and verified in codebase
- Lezer node names (A1): LOW — requires runtime verification

**Research date:** 2026-04-12
**Valid until:** 2026-05-12 (stable dependencies; CM6 API changes rarely)
