# Phase 3: Search - Research

**Researched:** 2026-04-12
**Domain:** Tantivy full-text indexing, fuzzy filename matching, incremental hash-driven indexer, Svelte sidebar tab switching
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Full-text search lives in the left sidebar as a tab, Obsidian-style. Two tabs at the top of the sidebar: "Dateien" (file tree) and "Suche" (search). Cmd/Ctrl+Shift+F switches directly to the Search tab and focuses the input.
- **D-02:** Search results show filename + 1-2 line context snippet with highlighted search term. Result counter at the top (e.g., "23 Treffer in 12 Dateien").
- **D-03:** Search updates live with ~200ms debounce as the user types. No Enter required.
- **D-04:** Quick Switcher is a centered modal in the upper third of the screen, Obsidian-style. Search field at top, scrollable result list below with filename + relative path. Arrow keys navigate, Enter opens, Escape closes.
- **D-05:** When opened with no input, the Quick Switcher shows recently opened files (from tabStore history). Typing switches to fuzzy filename matching.
- **D-06:** Fuzzy matching uses substring + word-initial matching. "mn" finds "meeting-notes.md". Matched characters are highlighted (bold) in the results.
- **D-07:** Clicking a search result opens the file in a new tab (or switches to existing tab if already open) and scrolls to the match location with a 2-3 second yellow flash-highlight on the matched text.
- **D-08:** Result display is capped at 100 files. If more matches exist, show hint: "Zeige 100 von 342 Treffern — Suche verfeinern".
- **D-09:** Automatic rebuild (schema mismatch / IndexCorrupt) shows a toast "Index wird neu aufgebaut..." + the existing ProgressBar. Search panel shows "Indexierung lauft..." and is not interactive during rebuild. Completion toast: "Index aktualisiert".
- **D-10:** Manual rebuild trigger is a button in the search panel header: "Index neu aufbauen" (refresh icon).
- **D-11:** During any index rebuild (auto or manual), the editor and file tree remain fully functional. Only the search panel is disabled. Non-blocking rebuild.

### Claude's Discretion

- Tantivy schema design — field names, tokenizer choice, stored vs. indexed fields, snippet generation strategy.
- Fuzzy matcher library — `fuzzy-matcher`, `nucleo`, `sublime_fuzzy`, or hand-rolled. Must meet <10ms budget on 100k filenames.
- Quick Switcher result limit — how many results to show before scrolling, max rendered items.
- Search query syntax help — whether to show a small hint about AND/OR/NOT/"phrase" syntax in the search panel.
- Central queue implementation — channel type (mpsc, crossbeam), queue depth, backpressure strategy.
- index_version.json schema — exact fields, version bumping strategy.
- SHA-256 caching strategy — where hashes are stored (memory-only vs. sidecar file), eviction on vault close.
- Tab-leiste visual details — exact styling of the Dateien/Suche tabs, active/inactive states, icon choices.
- Flash-highlight styling — exact yellow shade, animation duration, CSS transition vs. CM6 decoration.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| IDX-01 | Opening a vault indexes all `.md` files into Tantivy and into the in-memory metadata index | Tantivy `IndexWriter.add_document` + commit; `open_vault` walk in `vault.rs` to be replaced with real indexing |
| IDX-03 | Incremental re-indexing uses SHA-256 hash comparison; only changed files are re-parsed | `hash.rs` `hash_bytes` already exists; hash cache stored in `FileIndex` in-memory; delete_term + re-add_document pattern |
| IDX-04 | The in-memory index (FileIndex, LinkGraph, TagIndex) is rebuilt from disk on every cold start | `FileIndex` struct defined in spec §8.1; walk + parse all `.md` files on `open_vault` |
| IDX-05 | Tantivy index stores an `index_version.json` sidecar; on schema mismatch the index is deleted and rebuilt with progress UI | `index_version.json` next to index dir; version bump triggers wipe + rebuild; same `vault://index_progress` event channel |
| IDX-06 | All Tantivy writes go through a single central queue (never two concurrent writes for the same file) | `tokio::sync::mpsc` channel; single `IndexWriter` owner; serialized commit flush |
| IDX-08 | Non-UTF-8 files are shown in the browser but skipped by the indexer | `std::fs::read_to_string` returns `Err` on invalid UTF-8; log and skip silently |
| IDX-09 | User can trigger a manual index rebuild via `rebuild_index` command | New `#[tauri::command] async fn rebuild_index` in `commands/search.rs` |
| SRCH-01 | Cmd/Ctrl+Shift+F opens the full-text search panel | Keyboard shortcut in VaultLayout; switches to "Suche" tab + focuses `SearchInput` |
| SRCH-02 | Full-text search results include filename, relevance rank, and a contextual snippet | Tantivy `SnippetGenerator::create` + `snippet_from_doc()` + `to_html()` |
| SRCH-03 | Search supports AND, OR, NOT, and phrase queries ("exact text") | Tantivy `QueryParser` with `set_conjunction_by_default(false)`; phrase queries via `"..."` in query string |
| SRCH-04 | Cmd/Ctrl+P opens the Quick Switcher with fuzzy filename matching | Modal component mounted via Svelte portal; `nucleo-matcher` for filename matching |
| SRCH-05 | Quick Switcher and full-text search are backed by separate commands (`search_filename`, `search_fulltext`) | Two distinct Tauri commands in `commands/search.rs` |
| SRCH-06 | Clicking a search result opens the note at the match location | `tabStore.openTab(path)` + CM6 scroll-to-offset + flash decoration |
| ERR-02 | Index-corrupt detection triggers an automatic rebuild with progress UI | `VaultError::IndexCorrupt` handler in indexer; triggers same rebuild path as IDX-05; toast to frontend |
</phase_requirements>

---

## Summary

Phase 3 adds the Tantivy full-text search engine and a fuzzy-filename Quick Switcher to VaultCore. The Rust backend gains a new `src-tauri/src/indexer/` module (Tantivy wrapper, central write queue, in-memory file metadata) and a `commands/search.rs` module (three new Tauri commands). The frontend gains sidebar tab switching (Dateien/Suche), a SearchPanel component, and a QuickSwitcher modal.

The most technically demanding decisions are the **central write queue** (serializing all Tantivy writes through a single `tokio::sync::mpsc` channel so concurrent watcher events can never corrupt the index) and **incremental hashing** (reading SHA-256 from the in-memory `FileIndex` on re-open to skip unchanged files). The existing `hash_bytes` function in `hash.rs` covers the hashing side; the queue and indexer module are net-new.

For fuzzy filename matching, `nucleo-matcher` (0.3.1) is recommended over `fuzzy-matcher` (0.3.7) because nucleo is approximately 6x faster in benchmarks, is actively maintained (used in Helix editor), and its `nucleo-matcher` low-level crate lets the plan avoid the overhead of nucleo's async background thread pool (unnecessary for synchronous Tauri commands).

**Primary recommendation:** Add `tantivy = "0.26"` and `nucleo-matcher = "0.3"` to Cargo.toml. Build the indexer module around a single `IndexWriter` owned by a tokio task that receives work via `mpsc`. Store SHA-256 hashes in the in-memory `FileIndex` so warm starts skip unchanged files without any sidecar file.

---

## Standard Stack

### Core Rust Crates (to add to Cargo.toml)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tantivy | 0.26.0 | Full-text search engine | Spec-mandated (§12). Latest stable. Faster than Lucene, pure Rust, no C deps. |
| nucleo-matcher | 0.3.1 | Fuzzy filename matching | Used in Helix editor. ~6x faster than `fuzzy-matcher`. Synchronous low-level API suitable for Tauri command context. |
| pulldown-cmark | 0.13.3 | Strip Markdown to plain text for indexing | Already in spec §12; current registry version is 0.13.3 (spec listed 0.11). Plain text body improves search quality. |

**Crates NOT yet in Cargo.toml (need adding):**

```toml
tantivy = "0.26"
nucleo-matcher = "0.3"
pulldown-cmark = "0.13"   # strip MD markup before indexing body text
```

**Already in Cargo.toml and needed:**
- `sha2 = "0.10"` — SHA-256 hashing (hash.rs already provides `hash_bytes`)
- `tokio = { version = "1", features = ["full"] }` — mpsc channel for central queue
- `walkdir = "2"` — vault walk already used in vault.rs
- `rayon = "1"` — parallel parse during initial indexing
- `serde / serde_json = "1"` — index_version.json read/write
- `regex = "1"` — already present, used for wiki-link counting

[VERIFIED: npm registry / cargo search 2026-04-12] — tantivy 0.26.0, nucleo-matcher 0.3.1, pulldown-cmark 0.13.3 confirmed as latest on crates.io.

### Supporting Frontend Packages (no new npm installs needed)

All frontend work uses existing packages:
- `svelte` (5.55.3 installed) — stores, components
- `lucide-svelte` — icons (RefreshCw for rebuild button, X for clear)
- Existing `vc-*` CSS token system

---

## Architecture Patterns

### Recommended Project Structure

**New Rust modules:**
```
src-tauri/src/
├── indexer/
│   ├── mod.rs        # IndexCoordinator: owns IndexWriter, mpsc sender, FileIndex, rebuilds
│   ├── tantivy.rs    # Schema definition, Index open/create, SnippetGenerator helpers
│   ├── memory.rs     # FileIndex (HashMap<PathBuf, FileMeta>), hash cache
│   └── parser.rs     # Markdown → plain text body via pulldown-cmark
├── commands/
│   ├── search.rs     # search_fulltext, search_filename, rebuild_index commands (new)
│   └── vault.rs      # open_vault: replace walk-only body with indexer call (existing)
```

**New frontend structure:**
```
src/components/Search/
├── SidebarTabs.svelte      # Tab bar: Dateien / Suche
├── SearchPanel.svelte      # Search input + results + rebuild button
├── SearchInput.svelte      # Controlled input, 200ms debounce, clear button
├── SearchResults.svelte    # Scrollable result list, counter header
├── SearchResultRow.svelte  # Filename + snippet + highlighted match
├── QuickSwitcher.svelte    # Modal overlay, keyboard nav, portal mount
└── QuickSwitcherRow.svelte # Filename + relative path row

src/store/
└── searchStore.ts          # query, results, isSearching, isRebuilding state
```

### Pattern 1: Tantivy Schema Design

**What:** Define schema once at startup; validate against index_version.json on each open.

**Schema fields:**

```rust
// Source: Tantivy docs §8.2 (spec) + docs.rs/tantivy/0.26.0
let mut schema_builder = Schema::builder();
let path_field  = schema_builder.add_text_field("path",     STRING | STORED);  // exact, no tokenize
let title_field = schema_builder.add_text_field("title",    TEXT | STORED);
let body_field  = schema_builder.add_text_field("body",     TEXT | STORED);    // stored for snippet
let schema = schema_builder.build();
```

**Field decisions (Claude's Discretion):**
- `path`: `STRING` (not TEXT) — exact stored field, used as the delete_term key for updates.
- `body`: `TEXT | STORED` — stored so `SnippetGenerator` can extract snippets without re-reading disk.
- `title`: `TEXT | STORED` — H1 or filename stem.
- Tags deferred to Phase 5 (TAG-01..04 are Phase 5 requirements).
- Tokenizer: built-in `default` tokenizer (lowercase + punctuation split). ICU/stemming not available in Tantivy 0.26 without external crate; `default` is sufficient for the MVP budget and handles DE/EN adequately. [VERIFIED: docs.rs/tantivy/0.26.0/tantivy/tokenizer/]

**CURRENT_SCHEMA_VERSION = 1** stored in `index_version.json`.

### Pattern 2: Central Write Queue (IDX-06)

**What:** Single tokio task owns the `IndexWriter`. All indexing requests sent through `tokio::sync::mpsc`.

```rust
// Source: [ASSUMED] — standard tokio mpsc pattern for serialized async work
enum IndexCmd {
    AddFile { path: PathBuf, title: String, body: String, hash: String },
    DeleteFile { path: PathBuf },
    Commit,
    Rebuild { vault: PathBuf, app: AppHandle },
    Shutdown,
}

// In IndexCoordinator::spawn():
let (tx, mut rx) = tokio::sync::mpsc::channel::<IndexCmd>(1024);
tokio::spawn(async move {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            IndexCmd::AddFile { path, title, body, .. } => {
                let term = Term::from_field_text(path_field, path.to_str().unwrap());
                writer.delete_term(term);
                writer.add_document(doc!(path_field => ..., title_field => ..., body_field => ...))?;
            }
            IndexCmd::Commit => { writer.commit()?; }
            // ...
        }
    }
});
```

**Queue depth:** 1024. If the channel is full, `tx.try_send` returns `TrySendError::Full` — log and skip (watcher events are best-effort; the hash check will catch it on next open).

**Backpressure:** Use `tx.send(...).await` for open_vault indexing (must drain before returning). Use `tx.try_send(...)` for watcher events (fire and forget).

### Pattern 3: Incremental Hash-Driven Indexer (IDX-03)

**What:** On vault open, compare SHA-256 of each `.md` file against the cached hash in `FileIndex`. Only re-index changed files.

```rust
// Source: hash.rs (existing), [ASSUMED] pattern for in-memory diff
for path in md_files {
    let content = std::fs::read_to_string(&path)?;  // returns Err on non-UTF-8 (IDX-08)
    let hash = hash_bytes(content.as_bytes());
    if let Some(meta) = file_index.get(&path) {
        if meta.hash == hash {
            continue; // unchanged — skip Tantivy re-index
        }
    }
    // Changed or new file: update FileIndex + send to queue
    queue_tx.send(IndexCmd::AddFile { path, body: strip_markdown(&content), ... }).await?;
}
queue_tx.send(IndexCmd::Commit).await?;
```

**Hash storage:** In-memory only (`HashMap<PathBuf, FileMeta>`) — no sidecar file. Rebuilt from disk on every cold start (IDX-04 requirement). This means cold start always re-hashes all files, but hash computation is fast (< 1ms per file) and avoids sidecar file management complexity.

### Pattern 4: SnippetGenerator Usage (SRCH-02)

```rust
// Source: [CITED: docs.rs/tantivy/0.26.0/tantivy/snippet/struct.SnippetGenerator.html]
let searcher = index_reader.searcher();
let query = query_parser.parse_query(&query_str)?;
let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

let snippet_gen = SnippetGenerator::create(&searcher, &*query, body_field)?;
snippet_gen.set_max_num_chars(200);

for (score, doc_addr) in top_docs {
    let doc = searcher.doc(doc_addr)?;
    let snippet = snippet_gen.snippet_from_doc(&doc);
    let html = snippet.to_html(); // wraps matches in <b> tags
    // Return path, title, score, html snippet to frontend
}
```

**Frontend rendering:** The `html` field contains `<b>matched</b>` tags. Render with Svelte's `{@html snippet}` inside a sandboxed container (content is application-generated, not user-injected from network — acceptable per security posture).

### Pattern 5: QueryParser for AND/OR/NOT/Phrase (SRCH-03)

```rust
// Source: [CITED: docs.rs/tantivy/0.26.0/tantivy/query/struct.QueryParser.html]
let mut query_parser = QueryParser::for_index(&index, vec![title_field, body_field]);
// Default: OR between terms. set_conjunction_by_default() would change to AND.
// Leave default (OR) so "foo bar" returns documents with either word —
// user uses explicit AND operator when they want intersection.
// Phrase queries via "exact phrase" in input are handled natively.
let query = query_parser.parse_query_lenient(user_input);
// parse_query_lenient: never returns error, reports bad syntax separately
```

### Pattern 6: Fuzzy Filename Matching with nucleo-matcher (SRCH-04)

```rust
// Source: [CITED: docs.rs/nucleo-matcher/0.3.1/nucleo_matcher/]
use nucleo_matcher::{Config, Matcher, pattern::{Pattern, CaseMatching, Normalization}};

// Built once per vault open; stored in FileIndex or searchable Vec<String>
let file_paths: Vec<String> = file_index.all_relative_paths();

fn search_filename(query: &str, file_paths: &[String]) -> Vec<(u32, &str)> {
    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
    let mut matches: Vec<(u32, usize)> = file_paths
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let score = pattern.score(nucleo_matcher::Utf32Str::new(p, &mut vec![]), &mut matcher)?;
            Some((score, i))
        })
        .collect();
    matches.sort_by(|a, b| b.0.cmp(&a.0)); // descending score
    matches.iter().map(|(score, i)| (*score, file_paths[*i].as_str())).collect()
}
```

**Performance note:** nucleo-matcher runs synchronously on a single thread in the Tauri command context. At 100k filenames, the reject-early prefilter means most filenames are discarded in O(1) — empirically < 10ms at this scale. [MEDIUM confidence — nucleo's ~6x speed advantage over skim-based fuzzy-matcher is documented; exact 100k benchmark not confirmed in this session.]

### Pattern 7: index_version.json (IDX-05)

```json
{
  "schema_version": 1,
  "app_version": "0.1.0",
  "created_at": "2026-04-12T10:00:00Z"
}
```

**Location:** `<vault>/.vaultcore/index/index_version.json` (next to the Tantivy index directory at `<vault>/.vaultcore/index/tantivy/`).

**On open:**
1. Check if `index_version.json` exists.
2. If missing or `schema_version != CURRENT_SCHEMA_VERSION`: delete tantivy dir, rebuild from scratch.
3. If corrupt (JSON parse fails): same path as missing — delete and rebuild.
4. If `schema_version == CURRENT_SCHEMA_VERSION`: open existing index, run incremental hash diff.

**`VaultError::IndexCorrupt` detection:** Wrap all `Index::open` and `Searcher::search` calls; on `tantivy::TantivyError` → map to `VaultError::IndexCorrupt` → trigger rebuild path (ERR-02).

### Pattern 8: Sidebar Tab Switching (SRCH-01)

The existing `Sidebar.svelte` is an `<aside>` component. Phase 3 wraps it in a new `SidebarTabs.svelte` parent or refactors `Sidebar.svelte` to add a tab bar at the top and conditionally render the file tree vs. the search panel via a `{#if activeTab === 'search'}` block.

**Decision (Claude's Discretion):** Refactor `Sidebar.svelte` directly (add tab bar at top, conditional content). This avoids a wrapper component and keeps the sidebar layout in one file. The tab bar is 32px. No CSS `display:none` hack — use `{#if}` blocks so the search panel is not mounted until first use (saves memory).

**Keyboard shortcut wiring:** In `VaultLayout.svelte`, add `keydown` listener on `window`:
```typescript
if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'F') {
  e.preventDefault();
  sidebarActiveTab = 'search';
  // searchInputEl.focus() called after tick()
}
if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
  e.preventDefault();
  quickSwitcherOpen = true;
}
```

### Pattern 9: Flash Highlight on Scroll-to-Match (SRCH-06, D-07)

**What:** Apply a CM6 `Decoration.mark` to the matched text range; fade it out over 2.5 seconds via CSS transition.

```typescript
// Source: [ASSUMED] — CM6 StateField + Decoration pattern established in Phase 1
import { StateField, StateEffect, Decoration, EditorView } from "@codemirror/state";

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        if (e.value === null) return Decoration.none;
        return Decoration.set([
          Decoration.mark({ class: "vc-flash-highlight" }).range(e.value.from, e.value.to),
        ]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
```

CSS (in global styles):
```css
.vc-flash-highlight {
  background: #FEF9C3;
  transition: background 2500ms ease-out;
}
.vc-flash-highlight.vc-flash-done {
  background: transparent;
}
```

After 50ms, add class `vc-flash-done` via `requestAnimationFrame`; after 2600ms, dispatch `flashEffect(null)` to remove decoration.

### Anti-Patterns to Avoid

- **Do not share `IndexWriter` across threads directly.** It is `!Send`. Always own it inside a single tokio task and communicate via mpsc.
- **Do not call `writer.commit()` after every document.** Commit once after batching all documents for a vault open; commit once after each incremental watcher batch.
- **Do not store the Tantivy index inside the vault root at a user-visible path.** Use `<vault>/.vaultcore/` (dot-prefix = excluded by existing `is_excluded` helper).
- **Do not use `parse_query` (strict) for user input.** Use `parse_query_lenient` to avoid returning errors on partially-typed queries.
- **Do not mount QuickSwitcher inside the sidebar DOM.** Mount at `<body>` level to avoid z-index and stacking context conflicts with the sidebar.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Full-text search with ranking and snippets | Custom inverted index | `tantivy 0.26` | Segment merging, BM25 scoring, SnippetGenerator — months of work |
| Boolean query parsing (AND/OR/NOT/phrase) | Custom query parser | `tantivy::query::QueryParser` | Handles operator precedence, phrase queries, lenient fallback |
| Fuzzy string matching | Levenshtein loop | `nucleo-matcher 0.3` | Prefiltered, cache-optimized, handles Unicode normalization |
| Markdown-to-plain-text strip | Regex on MD syntax | `pulldown-cmark 0.13` | Handles nested structures, code fences, HTML blocks correctly |
| SHA-256 hashing | Custom hash | `sha2 0.10` (already in Cargo.toml) | NIST-verified, already wired in `hash.rs` |

**Key insight:** Tantivy's `SnippetGenerator` is the most underused built-in — it handles highlight offset mapping across tokenized positions, which is very hard to replicate correctly.

---

## Common Pitfalls

### Pitfall 1: IndexWriter Lifetime and `!Send`

**What goes wrong:** Code tries to put `IndexWriter` in `Arc<Mutex<...>>` and move it across tokio task boundaries — fails to compile (`IndexWriter: !Send` in older tantivy versions).

**Why it happens:** Tantivy's `IndexWriter` historically was not `Send`. As of 0.21+ it became `Send`, but the `MergePolicy` stored inside may not be.

**How to avoid:** Keep `IndexWriter` inside a single `tokio::spawn` task; never move it out. Accept work via `mpsc::Receiver`. [MEDIUM confidence — Send status should be verified at compile time; the task pattern avoids the issue regardless.]

**Warning signs:** Compiler error mentioning `IndexWriter: cannot be sent between threads safely`.

### Pitfall 2: Tantivy Index Not Flushed Before Search

**What goes wrong:** Documents are added but not yet committed; `searcher.search()` returns zero results even though indexing appears complete.

**Why it happens:** Tantivy uses a write-ahead pipeline; documents are in the `IndexWriter` buffer until `commit()` is called and the `IndexReader` is reloaded.

**How to avoid:** After all documents are added, send `IndexCmd::Commit` through the queue. The reader must call `reader.reload()` after commit. Use `IndexReader` created with `ReloadPolicy::OnCommitWithDelay` or manually reload.

**Warning signs:** Empty search results immediately after `open_vault` completes.

### Pitfall 3: Non-UTF-8 Files Crashing the Indexer

**What goes wrong:** `std::fs::read_to_string` panics or returns `Err` for non-UTF-8 files; uncaught error kills the indexer task.

**Why it happens:** `.md` files created by other tools sometimes have Latin-1 or Windows-1252 encoding.

**How to avoid:** Wrap every `read_to_string` in the indexer with `match`; on `Err`, log at debug level and continue (IDX-08 specifies silent skip).

**Warning signs:** Indexer task panics; subsequent searches return `IndexCorrupt`.

### Pitfall 4: index_version.json Schema Bump Infinite Loop

**What goes wrong:** Auto-rebuild writes a new `index_version.json` with wrong version number; every open triggers another rebuild.

**Why it happens:** `CURRENT_SCHEMA_VERSION` constant in code doesn't match the value written to JSON.

**How to avoid:** Write `CURRENT_SCHEMA_VERSION` to `index_version.json` after successful rebuild, not a hardcoded literal.

**Warning signs:** Vault open always shows rebuild progress, even on warm starts.

### Pitfall 5: Svelte `{@html}` with Unescaped Snippets

**What goes wrong:** Snippet HTML from Tantivy contains injected content from a malicious `.md` file.

**Why it happens:** `SnippetGenerator::to_html()` only wraps matched terms in `<b>` — the surrounding text is plain. But the body field itself was loaded from user `.md` files which may contain `<script>` tags.

**How to avoid:** Before indexing, strip all HTML tags from the body text using `pulldown-cmark` rendering to plain text (not HTML rendering). This ensures the stored body field is tag-free. The only HTML in the snippet then comes from `<b>` tags added by Tantivy.

**Warning signs:** XSS in search result snippets when vault contains `.md` files with raw HTML.

### Pitfall 6: Quick Switcher 10ms Budget on First Keypress

**What goes wrong:** First keypress triggers nucleo-matcher to allocate its internal state and warm up — that first call exceeds 10ms even if subsequent calls are fast.

**Why it happens:** `Matcher::new(Config::DEFAULT)` initializes thread-local state.

**How to avoid:** Construct the `Matcher` once when the vault opens (store in `AppState` or `IndexCoordinator`), not per `search_filename` call. `Matcher` is `!Send` so it must stay in the command thread or be wrapped in `thread_local!`.

**Warning signs:** First Quick Switcher keypress is slow; subsequent ones are fast.

### Pitfall 7: ProgressBar Reuse During Rebuild Conflicts with Bulk Watcher Progress

**What goes wrong:** Bulk file watcher changes (> 500 files) also trigger `progressStore`, causing the two progress sources to fight.

**Why it happens:** `progressStore` is a single store; both bulk watcher and index rebuild use it.

**How to avoid:** Add a `source: "index" | "watcher"` discriminator to `ProgressState`, or use two separate progress mechanisms. During rebuild, emit on the same `vault://index_progress` event (D-09 says reuse existing ProgressBar).

**Warning signs:** Progress bar shows watcher count during an index rebuild.

---

## Code Examples

### Opening an Existing Tantivy Index

```rust
// Source: [CITED: docs.rs/tantivy/0.26.0/tantivy/directory/struct.MmapDirectory.html]
use tantivy::{Index, directory::MmapDirectory};

fn open_index(index_path: &Path) -> tantivy::Result<Index> {
    let dir = MmapDirectory::open(index_path)?;
    Index::open(dir)
}

fn create_index(index_path: &Path, schema: Schema) -> tantivy::Result<Index> {
    std::fs::create_dir_all(index_path)?;
    Index::create_in_dir(index_path, schema)
}
```

### Upsert Pattern (Delete + Add for Incremental Update)

```rust
// Source: [CITED: docs.rs/tantivy/0.26.0/tantivy/struct.IndexWriter.html] + [ASSUMED] pattern
fn upsert_document(
    writer: &mut IndexWriter,
    path_field: Field,
    path: &str,
    title: &str,
    body: &str,
) -> tantivy::Result<()> {
    // Remove old version if it exists
    let path_term = Term::from_field_text(path_field, path);
    writer.delete_term(path_term);
    // Add new version
    writer.add_document(doc!(
        path_field => path,
        // title_field => title,   // include schema fields
        // body_field => body,
    ))?;
    Ok(())
}
```

### Stripping Markdown to Plain Text

```rust
// Source: [ASSUMED] — pulldown-cmark standard usage pattern
use pulldown_cmark::{Parser, Options, Event};

fn strip_markdown(md: &str) -> String {
    let parser = Parser::new_ext(md, Options::empty());
    let mut plain = String::with_capacity(md.len());
    for event in parser {
        match event {
            Event::Text(t) | Event::Code(t) => plain.push_str(&t),
            Event::SoftBreak | Event::HardBreak => plain.push(' '),
            _ => {}
        }
    }
    plain
}
```

### IPC Return Type for Search Results

```typescript
// src/ipc/commands.ts additions (following existing normalizeError pattern)
export interface SearchResult {
  path: string;           // absolute path
  title: string;
  score: number;
  snippet: string;        // HTML with <b>highlighted</b> terms
}

export interface FileEntry {
  path: string;           // relative path
  score: number;
}

export async function searchFulltext(query: string, limit: number): Promise<SearchResult[]> {
  try {
    return await invoke<SearchResult[]>("search_fulltext", { query, limit });
  } catch (e) { throw normalizeError(e); }
}

export async function searchFilename(query: string, limit: number): Promise<FileEntry[]> {
  try {
    return await invoke<FileEntry[]>("search_filename", { query, limit });
  } catch (e) { throw normalizeError(e); }
}

export async function rebuildIndex(): Promise<void> {
  try {
    await invoke<void>("rebuild_index");
  } catch (e) { throw normalizeError(e); }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tantivy 0.22 (spec §12) | tantivy 0.26.0 (registry) | 2024-2025 | Spec lists 0.22; actual latest is 0.26. Plan should use 0.26. |
| pulldown-cmark 0.11 (spec §12) | pulldown-cmark 0.13.3 (registry) | 2024 | Minor API compatibility — same `Event` enum, same usage pattern. |
| `fuzzy-matcher` (spec §12) | `nucleo-matcher 0.3` (recommended) | — | Claude's Discretion; nucleo is ~6x faster; helix-editor production-proven. |
| `chrono` (spec §12) | **forbidden** (D-19 in STATE.md) | Phase 1 | D-19 bans chrono; existing `chrono_like_iso()` in vault.rs is the approved replacement. |

**Deprecated/outdated:**
- `chrono = "0.4"` (listed in spec §12): D-19 forbids it. Hand-rolled ISO-8601 formatter in vault.rs is the established pattern.
- `fuzzy-matcher = "0.3"` (spec §12): Superseded by `nucleo-matcher` per Claude's Discretion; ~30% documented vs nucleo's mature API.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `IndexWriter` is `Send` in tantivy 0.26, allowing it to be moved into a tokio task | Architecture Patterns (Pattern 2) | Compile error; workaround: wrap in `Arc<Mutex<>>` or use `spawn_blocking` |
| A2 | nucleo-matcher synchronous matching of 100k filenames completes in < 10ms | Architecture Patterns (Pattern 6) | Would need to add async/background matching via full `nucleo` crate; more integration complexity |
| A3 | Central queue with depth 1024 and `try_send` for watcher events provides adequate backpressure without dropping critical updates | Architecture Patterns (Pattern 2) | High-velocity watcher events during bulk operations could silently drop index updates; mitigated by hash re-check on next open |
| A4 | Storing index at `<vault>/.vaultcore/index/` (dot-prefix dir) will be excluded by the existing `is_excluded` helper in vault.rs | Architecture Patterns | Index dir appears in file browser; fix: verify `is_excluded` in vault.rs depth-check covers all dotfiles |
| A5 | `parse_query_lenient` is available in tantivy 0.26 | Architecture Patterns (Pattern 5) | Fall back to `parse_query` with explicit error handling; user sees no error on partial input |
| A6 | tokio mpsc channel `send().await` won't deadlock if called from an async Tauri command and the queue consumer is in a separate `tokio::spawn` | Architecture Patterns (Pattern 2) | Would need to use `try_send` everywhere; change backpressure strategy |

---

## Open Questions (RESOLVED)

1. **IndexWriter Send-ness in tantivy 0.26**
   - What we know: tantivy 0.21+ made IndexWriter Send in most configurations
   - What's unclear: whether the default MergePolicy is also Send in 0.26
   - Recommendation: Attempt `tokio::spawn(async move { ... writer ... })` in Wave 0; if compile fails, use `spawn_blocking` instead
   - RESOLVED: Plan 03-01 Task 2 spawns the queue consumer via `tokio::spawn` with IndexWriter owned inside the task. If Send is not satisfied at compile time, the executor will fall back to `spawn_blocking` as recommended. The mpsc queue pattern isolates IndexWriter ownership regardless.

2. **Tantivy index location inside vault**
   - What we know: Spec says "neben dem Tantivy-Index-Verzeichnis" (next to index dir)
   - What's unclear: Exact path not specified — `<vault>/.vaultcore/` would be ignored by `is_excluded` (dot prefix) but isn't in the spec
   - Recommendation: Use `<app_data_dir>/vaultcore/indexes/<vault_hash>/` — completely outside vault, no risk of appearing in file browser or being accidentally committed to git. Avoids contaminating the user's Obsidian vault.
   - RESOLVED: Plan 03-01 Task 2 chose `<vault>/.vaultcore/index/tantivy/` (inside vault, dot-prefix hidden), deviating from the research recommendation of `<app_data_dir>`. Rationale: simpler implementation, `.vaultcore` is excluded from the file tree browser (Plan 01 Task 2 adds exclusion), and co-locating the index with the vault makes portability straightforward. Users can `.gitignore` the directory.

3. **Warm start hash diff performance at 100k files**
   - What we know: `hash_bytes` is fast; reading 100k file stat mtimes is fast; reading file content to hash is slow
   - What's unclear: Whether to hash only changed files (by mtime first) or hash all files always
   - Recommendation: Two-pass — first check `fs::metadata().modified()` against stored `modified_at`; only read+hash files whose mtime changed. This makes warm start essentially O(mtime checks) not O(file reads).
   - RESOLVED: Plan 03-01 Task 2 implements SHA-256 hash comparison for all files on warm start (single-pass, hash all). The mtime two-pass optimization is deferred. Current approach reads+hashes every file but skips Tantivy re-indexing for unchanged hashes. This is correct but not optimal at 100k scale; the mtime optimization can be added in Phase 6 if benchmarks show warm start exceeds budget.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust toolchain | Cargo.toml compilation | Assumed present (Phases 1-2 compiled) | >= 1.77.2 | — |
| tantivy 0.26 | IDX-01, SRCH-02, SRCH-03 | Not yet in Cargo.toml | 0.26.0 (registry) | — |
| nucleo-matcher 0.3 | SRCH-04 | Not yet in Cargo.toml | 0.3.1 (registry) | fuzzy-matcher 0.3.7 (slower, lower quality docs) |
| pulldown-cmark 0.13 | IDX-01 (body text extraction) | Not yet in Cargo.toml | 0.13.3 (registry) | regex-based strip (fragile) |

**Missing dependencies with no fallback:**
- `tantivy = "0.26"` — blocks all IDX and SRCH requirements; must be added in Wave 0.

**Missing dependencies with fallback:**
- `nucleo-matcher = "0.3"` — fallback is `fuzzy-matcher = "0.3"` (in spec §12, simpler API but ~6x slower).
- `pulldown-cmark = "0.13"` — fallback is regex strip (fragile for nested structures).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust: `cargo test` (built-in) / Frontend: not yet established |
| Config file | `src-tauri/src/tests/mod.rs` (existing pattern) |
| Quick run command | `cargo test -p vaultcore --lib 2>&1 \| tail -20` (from `src-tauri/`) |
| Full suite command | `cargo test -p vaultcore 2>&1` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IDX-01 | Files indexed into Tantivy on open_vault | unit | `cargo test -p vaultcore indexer::tests::test_initial_index` | ❌ Wave 0 |
| IDX-03 | Only changed files re-indexed (hash diff) | unit | `cargo test -p vaultcore indexer::tests::test_incremental_hash` | ❌ Wave 0 |
| IDX-05 | Schema mismatch triggers rebuild | unit | `cargo test -p vaultcore indexer::tests::test_schema_version_mismatch` | ❌ Wave 0 |
| IDX-06 | No concurrent writes (queue serialization) | unit | `cargo test -p vaultcore indexer::tests::test_queue_serialization` | ❌ Wave 0 |
| IDX-08 | Non-UTF-8 files silently skipped | unit | `cargo test -p vaultcore indexer::tests::test_non_utf8_skip` | ❌ Wave 0 |
| SRCH-02 | search_fulltext returns snippet + filename | unit | `cargo test -p vaultcore commands::search::tests::test_fulltext_returns_snippet` | ❌ Wave 0 |
| SRCH-03 | AND/OR/NOT/phrase queries parsed | unit | `cargo test -p vaultcore commands::search::tests::test_query_operators` | ❌ Wave 0 |
| SRCH-04 | search_filename fuzzy matches "mn" → "meeting-notes.md" | unit | `cargo test -p vaultcore commands::search::tests::test_fuzzy_match` | ❌ Wave 0 |
| ERR-02 | IndexCorrupt triggers auto-rebuild | unit | `cargo test -p vaultcore indexer::tests::test_corrupt_index_rebuild` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo test -p vaultcore --lib 2>&1 | tail -30` (unit tests only, < 30s)
- **Per wave merge:** `cargo test -p vaultcore 2>&1` (all tests including integration)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/indexer/mod.rs` — IndexCoordinator + queue; test file `src-tauri/src/tests/indexer.rs`
- [ ] `src-tauri/src/indexer/tantivy.rs` — schema, open/create, SnippetGenerator helpers
- [ ] `src-tauri/src/indexer/memory.rs` — FileIndex HashMap + FileMeta struct
- [ ] `src-tauri/src/indexer/parser.rs` — `strip_markdown` using pulldown-cmark
- [ ] `src-tauri/src/commands/search.rs` — three new commands + test module
- [ ] Framework install: `tantivy = "0.26"`, `nucleo-matcher = "0.3"`, `pulldown-cmark = "0.13"` added to `src-tauri/Cargo.toml`

---

## Security Domain

> `security_enforcement` not set to false in config.json — section required.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Not applicable — local-only app, no auth |
| V3 Session Management | no | Not applicable |
| V4 Access Control | yes | Vault-scope guard: all search commands validate path is inside `current_vault` before reading (T-02 mitigation, established in Phase 1) |
| V5 Input Validation | yes | `parse_query_lenient` for user search input (no panic on malformed queries); `nucleo-matcher` accepts raw strings safely |
| V6 Cryptography | no | SHA-256 used for change detection only, not security — no cryptographic requirements |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via search result path | Tampering | `canonical.starts_with(&vault_path)` check in every command (established T-02 pattern) |
| XSS via snippet HTML in `{@html}` | Tampering | Strip HTML from `.md` body before indexing with `pulldown-cmark` plain-text render; only `<b>` tags from Tantivy enter the DOM |
| Vault index stored in user's git repo | Info Disclosure | Store index in `<app_data_dir>` outside vault, OR in `<vault>/.vaultcore/` which is `.gitignore`-able and excluded from file browser by `is_excluded` |
| IndexWriter shared across threads unsafely | Denial of Service | Central mpsc queue pattern — single owner, no shared mutable state |

---

## Project Constraints (from CLAUDE.md)

All directives that constrain Phase 3 planning:

| Constraint | Source | Impact on Phase 3 |
|-----------|--------|-------------------|
| Tech stack locked: Tauri 2, Rust, TypeScript, CM6, Tantivy, Zustand, Tailwind | CLAUDE.md §Constraints | No alternative search engines; no alternative state managers |
| Full-text search < 50ms on 100k notes | CLAUDE.md §Constraints | Tantivy with MmapDirectory; SnippetGenerator must not add >10ms |
| Quick Switcher < 10ms on 100k files | CLAUDE.md §Constraints | nucleo-matcher preferred; Matcher instance must be pre-warmed |
| Initial indexing < 60s on 100k files | CLAUDE.md §Constraints | Parallel parse with rayon; batch commit (not per-file commit) |
| Incremental update < 5ms | CLAUDE.md §Constraints | Single delete_term + add_document + commit per watcher event |
| RAM idle < 100MB, active < 250MB | CLAUDE.md §Constraints | Body field stored in Tantivy (memory-mapped); FileIndex metadata only (not body) in RAM |
| Zero network calls | CLAUDE.md §Constraints | Confirmed — all tantivy/nucleo operations are local |
| No telemetry | CLAUDE.md §Constraints | Confirmed — no analytics in search module |
| D-19: no chrono crate | STATE.md Decisions | Use existing `chrono_like_iso()` in vault.rs for any timestamps in index_version.json |
| Classic Svelte writable stores (D-06/RC-01) | STATE.md Decisions | `searchStore.ts` must use `writable`, not `$state` class wrappers |
| No `$state` on CM6 `EditorView` (RC-01) | STATE.md Decisions | Flash-highlight CM6 extension must use `StateField`, not reactive state |
| All IPC through `src/ipc/commands.ts` (T-02-01) | STATE.md Decisions | `searchFulltext`, `searchFilename`, `rebuildIndex` must go through typed wrappers |
| serde `rename_all = "camelCase"` on IPC structs | STATE.md Decisions | `SearchResult` and `FileEntry` Rust structs need `#[serde(rename_all = "camelCase")]` |
| German UI strings | MEMORY.md | All user-facing strings in German (Suche, Dateien, Treffer, etc.); code/commits in English |

---

## Sources

### Primary (HIGH confidence)
- [docs.rs/tantivy/0.26.0](https://docs.rs/tantivy/0.26.0/tantivy/) — SnippetGenerator, QueryParser, tokenizers, IndexWriter, MmapDirectory
- [docs.rs/nucleo-matcher/0.3.1](https://docs.rs/nucleo-matcher/0.3.1/nucleo_matcher/) — Matcher, Pattern, Config API
- `src-tauri/Cargo.toml` — confirmed tantivy/nucleo NOT yet in dependencies
- `src-tauri/src/lib.rs` — VaultState struct, current command registrations
- `src-tauri/src/hash.rs` — `hash_bytes` function (SHA-256, already implemented)
- `src-tauri/src/commands/vault.rs` — `open_vault`, `collect_file_list`, `is_excluded` helpers
- `.planning/phases/03-search/03-CONTEXT.md` — locked decisions D-01..D-11
- `.planning/phases/03-search/03-UI-SPEC.md` — component inventory, interaction contracts, copywriting
- `VaultCore_MVP_Spezifikation_v3.md` §8.2, §9, §11, §12, §17 — schema spec, IPC commands, backend structure, crate list
- cargo search (2026-04-12): tantivy=0.26.0, nucleo-matcher=0.3.1, nucleo=0.5.0, fuzzy-matcher=0.3.7, pulldown-cmark=0.13.3

### Secondary (MEDIUM confidence)
- WebSearch: nucleo ~6x faster than skim (fuzzy-matcher) — [github.com/helix-editor/nucleo](https://github.com/helix-editor/nucleo)
- WebSearch: tantivy 0.26 latest confirmed — [crates.io/crates/tantivy/versions](https://crates.io/crates/tantivy/versions)

### Tertiary (LOW confidence)
- `IndexWriter: Send` in tantivy 0.26 — inferred from 0.21+ changelog; not directly verified in this session

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified via cargo search; tantivy/nucleo versions confirmed on crates.io
- Architecture: HIGH — Tantivy API verified via docs.rs; patterns align with spec §8.2 and existing codebase
- Pitfalls: MEDIUM — pitfalls 1, 2, 3 verified via docs; pitfalls 4, 5, 6, 7 from pattern analysis
- Performance claims: MEDIUM — nucleo benchmarks sourced from helix-editor docs; exact 100k numbers not benchmarked in this session

**Research date:** 2026-04-12
**Valid until:** 2026-05-12 (tantivy is fast-moving; verify version before executing)
