---
phase: 03-search
reviewed: 2026-04-12T00:00:00Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - src/components/Editor/EditorPane.svelte
  - src/components/Editor/extensions.ts
  - src/components/Editor/flashHighlight.ts
  - src/components/Layout/VaultLayout.svelte
  - src/components/Search/QuickSwitcherRow.svelte
  - src/components/Search/QuickSwitcher.svelte
  - src/components/Search/SearchInput.svelte
  - src/components/Search/SearchPanel.svelte
  - src/components/Search/SearchResultRow.svelte
  - src/components/Search/SearchResults.svelte
  - src/components/Sidebar/Sidebar.svelte
  - src/ipc/commands.ts
  - src/store/scrollStore.ts
  - src/store/searchStore.ts
  - src/styles/tailwind.css
  - src-tauri/Cargo.toml
  - src-tauri/src/commands/mod.rs
  - src-tauri/src/commands/search.rs
  - src-tauri/src/commands/vault.rs
  - src-tauri/src/indexer/memory.rs
  - src-tauri/src/indexer/mod.rs
  - src-tauri/src/indexer/parser.rs
  - src-tauri/src/indexer/tantivy_index.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/tests/indexer.rs
findings:
  critical: 2
  warning: 5
  info: 4
  total: 11
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-04-12T00:00:00Z
**Depth:** standard
**Files Reviewed:** 25
**Status:** issues_found

## Summary

This phase implements full-text search (Tantivy/BM25), fuzzy filename search (nucleo), a Quick Switcher modal, a Search panel, and the scroll-to-match flash highlight. The Rust backend is structurally sound and the XSS mitigation strategy for Tantivy snippets is correctly layered. However two critical issues were found: an `{@html}` injection surface where untrusted snippet content is rendered directly into the DOM, and a broken `{#each}` key in `QuickSwitcherRow` that causes severe rendering bugs. Five warnings cover logic errors and missing error-handling paths that can silently misfire at runtime.

---

## Critical Issues

### CR-01: XSS via `{@html result.snippet}` on untrusted snippet content

**File:** `src/components/Search/SearchResultRow.svelte:23`

**Issue:** The snippet field is rendered with `{@html result.snippet}`. The code comment in `search.rs` (T-03-07) states that only `<b>` tags are emitted by Tantivy's `SnippetGenerator`. This relies entirely on the Tantivy library never changing its output and on the body field being perfectly sanitized at index time by `parser::strip_markdown`. However, `strip_markdown` uses `pulldown-cmark` with `Options::empty()`, which does **not** enable the `ENABLE_SMART_PUNCTUATION` or raw-HTML extension — good. But pulldown-cmark's `Event::Html` arm is silently dropped (`_ => {}`), meaning raw HTML in a note body (e.g. `<script>alert(1)</script>`) is stripped before indexing. That path is safe.

The remaining risk is that `SnippetGenerator::snippet_from_doc` builds its HTML by wrapping matched byte ranges with `<b>` and `</b>` using string manipulation over the stored plain-text body. If the stored body accidentally contains `<` or `>` characters (they are not escaped before insertion into Tantivy's TEXT field), the generated snippet can contain literal angle-bracket sequences that survive into the HTML output. For example a note body `a < b` stored verbatim would appear as `a <b>matched</b> b` in a snippet context — close but illustrative. A more realistic vector: a note body containing `</b><script>alert(1)</script><b>` would survive `strip_markdown` (it is not HTML in Markdown; `Event::Html` only fires for Markdown raw-HTML blocks, not inline text), get stored verbatim, and Tantivy's `to_html()` would embed it literally inside `<b>` delimiters.

The defense-in-depth fix is to HTML-escape the plain-text body before storing it in Tantivy, or to sanitize the snippet on the frontend before passing to `{@html}`. The current code has no such sanitization step.

**Fix:** In `src-tauri/src/indexer/parser.rs`, HTML-escape the output of `strip_markdown` before it is stored as the `body` field, so the only `<`/`>` characters that appear in stored text are impossible:

```rust
// In indexer/parser.rs, after strip_markdown returns:
pub fn strip_and_escape_markdown(md: &str) -> String {
    let plain = strip_markdown(md);
    // Escape HTML special chars so SnippetGenerator cannot produce injected tags.
    plain
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
```

Then replace all calls to `parser::strip_markdown` in `mod.rs` with `parser::strip_and_escape_markdown`. The Tantivy `to_html()` output will then only ever contain `<b>` / `</b>` wrapper tags and HTML-escaped body text, which is safe to render via `{@html}`.

---

### CR-02: Non-unique `{#each}` key causes mismatched DOM nodes in `QuickSwitcherRow`

**File:** `src/components/Search/QuickSwitcherRow.svelte:38`

**Issue:** The `{#each filenameChars as { char, highlighted } (char + Math.random())}` key is `char + Math.random()`. Svelte uses the key expression to identify which DOM node corresponds to which list item across re-renders. Using `Math.random()` means the key is **different on every render** — Svelte will destroy and recreate every `<span>` on every reactive update, including every keystroke in the input. This defeats the keyed-each optimization entirely, causes visible flickering when the list updates rapidly, and leaks DOM nodes during transitions. Additionally, if two characters in the filename are identical (e.g. `"notes"` has two `"s"` chars with different `highlighted` values), using only `char` as part of the key already produces duplicates; but with `Math.random()` the key is never stable regardless.

**Fix:** Use the character index as the key, which is guaranteed unique per filename and stable across re-renders:

```svelte
{#each filenameChars as { char, highlighted }, i (i)}
  {#if highlighted}
    <span style="font-weight: 700; color: var(--color-accent)">{char}</span>
  {:else}
    {char}
  {/if}
{/each}
```

---

## Warnings

### WR-01: Wrong error message shown for non-disk-full write failures

**File:** `src/components/Editor/EditorPane.svelte:214`

**Issue:** The `else` branch of the disk-full error handler shows the message `"Disk full. Could not save changes."` even when the error is something completely different (permission denied, network filesystem error, etc.). The `isDiskFull` path uses the correct message, but the catch-all `else` on line 214 copies the same string instead of using a generic save-failure message.

```typescript
} else {
  toastStore.push({ variant: "error", message: "Disk full. Could not save changes." }); // wrong
}
```

**Fix:**
```typescript
} else {
  toastStore.push({ variant: "error", message: "Could not save changes." });
}
```

---

### WR-02: `searchStore.setSearching(false)` never called on search error

**File:** `src/components/Search/SearchPanel.svelte:37-40`

**Issue:** In `handleSearch`, `searchStore.setSearching(true)` is set before the IPC call on line 33. If `searchFulltext` throws, the `catch` block calls `searchStore.setSearching(false)` — but this is missing. Only the `setSearching(false)` inside `setResults` (which is only called on success) clears the flag. The `catch` block only calls `searchStore.setSearching(false)` and pushes a toast.

Wait — re-reading lines 37-40:
```typescript
} catch (e) {
  searchStore.setSearching(false);
  toastStore.push(...)
}
```

Actually `setSearching(false)` IS called in the catch. This is correct. Removing this from findings.

*(Self-correction applied — WR-02 renumbered below.)*

---

### WR-02: `scrollStore` subscriber fires on every store update but has no token deduplication guard

**File:** `src/components/Editor/EditorPane.svelte:81-98`

**Issue:** The `scrollStore` subscriber in `EditorPane` runs on every store update. The store's `pending` object is set with `crypto.randomUUID()` as a `token` field specifically to detect new requests, but the subscriber never reads `state.pending.token`. This means if two rapid search-result clicks produce the same `filePath` + `searchText` (e.g. clicking the same result twice), the second request may be missed entirely because `scrollStore.clearPending()` was called after the first and the store is now `null`. Conversely, if another subscriber (a second `EditorPane` in split view) also calls `clearPending()` after processing the request, the other pane will find `null` and skip the scroll — this is intentional and correct. But the `token` field on line 33 of `scrollStore.ts` is written but never read anywhere, making it dead code that gives a false impression of deduplication safety.

**Fix:** Either remove the `token` field from `ScrollRequest` to avoid confusion, or actually read it in the subscriber to detect whether a new request arrived since the last one was processed:

```typescript
let lastToken: string | null = null;
const unsubScroll = scrollStore.subscribe((state) => {
  if (!state.pending) return;
  if (state.pending.token === lastToken) return; // already handled
  lastToken = state.pending.token;
  // ... rest of handler
});
```

---

### WR-03: `open_vault` leaves `index_coordinator` as `None` on `index_vault` failure

**File:** `src-tauri/src/commands/vault.rs:174-188`

**Issue:** The `open_vault` command temporarily takes the coordinator out of `state.index_coordinator` with `guard.take().unwrap()` (line 174), calls `coordinator.index_vault(...)`, and then puts it back on line 184. If `index_vault` returns an `Err`, the function returns early (line 179) **without** putting the coordinator back. After a failed `index_vault`, `state.index_coordinator` is `None` permanently for the rest of the session. Any subsequent calls to `search_fulltext`, `search_filename`, or `rebuild_index` will silently return empty results (`Ok(Vec::new())`) rather than surfacing an error. The user sees the vault "open" with no search functionality and no error explanation.

**Fix:** Use a `scopeguard`-style pattern or restore on error:

```rust
let vault_info = match coordinator.index_vault(&canonical, &app).await {
    Ok(info) => info,
    Err(e) => {
        // Restore coordinator before returning error
        let mut guard = state.index_coordinator.lock().map_err(|_| VaultError::Io(
            std::io::Error::new(std::io::ErrorKind::Other, "internal state lock poisoned"),
        ))?;
        *guard = Some(coordinator);
        log::error!("index_vault failed: {e:?}");
        return Err(e);
    }
};
```

---

### WR-04: `IndexCmd::Rebuild` does not update the in-memory `FileIndex`

**File:** `src-tauri/src/indexer/mod.rs:319-352`

**Issue:** When `IndexCmd::Rebuild` is processed in `run_queue_consumer`, it re-walks the vault and re-adds all documents to Tantivy (correctly), but it never updates the in-memory `FileIndex`. After a rebuild, `FileIndex` still contains the pre-rebuild hash state. This causes the incremental indexing logic (`already_current` check at line 192 of `mod.rs`) to believe files are unchanged on the next incremental pass and skip re-indexing them — even if the rebuild was triggered because the index was corrupt and the hashes are stale. Similarly, `search_filename` uses `file_index.all_relative_paths()` to enumerate files for nucleo matching; if files were added or deleted while the index was stale, the filename search results will be wrong after rebuild.

The `run_queue_consumer` task receives `_file_index: Arc<Mutex<FileIndex>>` as a parameter (prefixed with `_` indicating it is intentionally unused), confirming this was a known gap.

**Fix:** In the `IndexCmd::Rebuild` arm, clear and repopulate `file_index` to match the re-walked file set:

```rust
IndexCmd::Rebuild { vault_path } => {
    if let Err(e) = writer.delete_all_documents() { ... }
    let paths = collect_md_paths(&vault_path);
    // Clear stale in-memory index
    {
        let mut fi = _file_index.lock().expect("file_index lock");
        fi.clear();
    }
    for abs_path in paths {
        // ... existing add_document logic ...
        // Also update file_index:
        let mut fi = _file_index.lock().expect("file_index lock");
        fi.insert(abs_path.clone(), FileMeta {
            relative_path: /* computed rel path */,
            hash: hash_bytes(content.as_bytes()),
            title: title.clone(),
        });
    }
    // ...
}
```

---

### WR-05: `VaultLayout.svelte` has two `onMount` calls — second one's cleanup runs immediately

**File:** `src/components/Layout/VaultLayout.svelte:36-44` and `102-109`

**Issue:** There are two separate `onMount(() => { ... })` calls. The first (lines 36-44) reads `localStorage` and is fine. The second (lines 102-109) adds `mousemove`/`mouseup` listeners and returns a cleanup function. In Svelte 5, the return value of `onMount` is used as the cleanup callback (equivalent to `onDestroy`). However, `onDestroy` on line 111 **also** calls `document.removeEventListener` for those same listeners. This means the listeners are removed twice — once by the `onMount` cleanup return (when the component is destroyed) and once in the explicit `onDestroy`. While double-removal is not harmful in itself (the second `removeEventListener` is a no-op if the reference matches), this double-registration pattern creates confusion: if the first `onMount` returns a cleanup function and the component is unmounted during SSR or fast remounts, the cleanup fires while `onDestroy` may not, or vice versa depending on framework version.

More concretely: the second `onMount`'s cleanup return (the arrow function `() => { document.removeEventListener... }`) is **the** cleanup registered with Svelte. The explicit `onDestroy` on line 111 removes the same listeners again — which is harmless but indicates the developer may not have realized the `onMount` return already handles cleanup. The real risk is that the first `onMount` has no cleanup, so `localStorage` parsing happens but any side effects are never undone (acceptable in this case).

**Fix:** Remove the explicit `document.removeEventListener` calls from `onDestroy` since the second `onMount`'s return value already handles them, reducing the chance of future confusion when someone adds a listener expecting the `onMount` pattern to be the only cleanup site:

```svelte
onDestroy(() => {
  unsubTab();
  // mousemove/mouseup cleanup is handled by the onMount return value
});
```

---

## Info

### IN-01: Dead code — `token` field in `ScrollRequest` is never read

**File:** `src/store/scrollStore.ts:16`

**Issue:** The `token: string` field is generated with `crypto.randomUUID()` on every `requestScrollToMatch` call but is never read by any subscriber. The field is documented as "unique token to detect new requests" but the detection logic is absent. This is misleading to future readers.

**Fix:** Remove the field if deduplication is not needed, or implement the token comparison in `EditorPane`'s subscriber (see WR-02).

---

### IN-02: `getSelectedFolder` in `Sidebar.svelte` only checks root entries for directory detection

**File:** `src/components/Sidebar/Sidebar.svelte:154-159`

**Issue:** `getSelectedFolder` looks up `selectedPath` only in `rootEntries` to determine if it is a directory. If the user has selected a file or folder nested deeper than the root level, `rootEntries.find(e => e.path === selectedPath)` will not find it and the function returns `null`, so new files/folders are always created in the vault root instead of in the selected folder.

**Fix:** Either pass the `is_dir` flag along with `selectedPath` through the selection callback, or check the selected path against the full tree rather than just `rootEntries`.

---

### IN-03: `QuickSwitcher.svelte` — `import { onDestroy }` placed after component logic

**File:** `src/components/Search/QuickSwitcher.svelte:130`

**Issue:** The `import { onDestroy } from "svelte"` statement appears at line 130, inside the `<script>` block but after all the component's runtime logic. While JavaScript hoists `import` declarations, this placement is non-idiomatic and will confuse linters and future editors who expect all imports at the top of the script block.

**Fix:** Move the import to line 2 alongside the other `svelte` imports:

```typescript
import { onMount, tick, onDestroy } from "svelte";
```

---

### IN-04: `SearchResults.svelte` overflow message is logically incorrect

**File:** `src/components/Search/SearchResults.svelte:27-30`

**Issue:** The overflow notice reads `"Zeige 100 von {results.length} Treffern"` and is shown when `results.length >= 100`. But `results` is already capped at `limit` (100) on the Rust side — `results.length` will never exceed 100. The message will always say "Zeige 100 von 100 Treffern" which is confusing (it implies there are more than 100 results but the display only shows the count that was returned). The `totalMatches` field in `searchStore` is also set to `results.length` (the capped value), so there is no source of the "real" unbounded count available at this layer.

**Fix:** Change the message to remove the misleading "von N" total, since the backend does not expose the true match count:

```svelte
{#if results.length >= 100}
  <p class="vc-search-results-overflow">
    Mehr als 100 Treffer — Suche verfeinern
  </p>
{/if}
```

Or, expose the true total from Tantivy via an additional `total_count` field in `SearchResult` / a separate count query, and display it accurately.

---

_Reviewed: 2026-04-12T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
