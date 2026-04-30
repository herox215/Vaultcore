<script lang="ts">
  // #174 — OmniSearch: the single modal replacement for SearchPanel +
  // QuickSwitcher. Spotlight-style UI with two modes:
  //   - filename:  fuzzy filename + alias hits (search_filename via nucleo)
  //   - content:   full-text BM25 hits with snippets (search_fulltext)
  //
  // Extras over the old QuickSwitcher:
  //   - auto-rebuild: opening the modal with a stale index kicks off
  //     rebuild_index in the background and surfaces a compact status line
  //     under the query. The user never has to click a rebuild button.
  //   - tag-click prefill: TagsPanel passes a `#tag` query + content mode;
  //     we auto-run the search on first mount.
  //
  // DOM class naming retains the `.vc-qs-*` selectors from the old
  // QuickSwitcher — many WDIO specs target them and this refactor is
  // frontend-only, so keeping the classes minimises E2E churn.

  import { onDestroy, tick } from "svelte";
  import { tabStore } from "../../store/tabStore";
  import { vaultStore } from "../../store/vaultStore";
  import { searchStore } from "../../store/searchStore";
  import { scrollStore } from "../../store/scrollStore";
  import {
    searchFilename,
    searchFulltext,
    rebuildIndex,
  } from "../../ipc/commands";
  import type { FileMatch, SearchResult } from "../../types/search";
  import { isVaultError } from "../../types/errors";
  import { extractSnippetMatch } from "../Editor/flashHighlight";
  import QuickSwitcherRow from "./QuickSwitcherRow.svelte";
  import SearchResultRow from "./SearchResultRow.svelte";
  import {
    computeRecentFiles,
    recentsSignature,
    type RecentEntry,
  } from "./recentFiles";

  type OmniMode = "filename" | "content";

  // #261 — content mode used to request k=100 per keystroke; the result list
  // only shows ~8–15 rows before the user has to scroll or re-type. Start
  // with a viewport-sized window and let the user opt into more via a
  // "Mehr laden" button at the bottom. Each click grows the k by the same
  // increment so the UX is "show me another page" without having to pick a
  // number.
  const CONTENT_SEARCH_INITIAL_K = 20;
  const CONTENT_SEARCH_K_INCREMENT = 30;

  interface Props {
    open: boolean;
    initialMode?: OmniMode | undefined;
    /** Prefilled query — used when TagsPanel opens the omni on a tag click. */
    initialQuery?: string | undefined;
    onClose: () => void;
    onOpenFile: (path: string) => void;
  }

  let {
    open,
    initialMode = "filename",
    initialQuery = undefined,
    onClose,
    onOpenFile,
  }: Props = $props();

  // ── Local state ────────────────────────────────────────────────────
  let mode = $state<OmniMode>("filename");
  let query = $state("");
  let fileResults = $state<FileMatch[]>([]);
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>();

  // Generation counter to drop stale content-mode result resolutions —
  // concurrent search_fulltext promises can race during / after a rebuild
  // and an older promise resolving last would stomp the newer results.
  let contentSearchGen = 0;

  // Content-mode debounce handle (same 200ms feel as the old SearchPanel).
  let contentDebounce: ReturnType<typeof setTimeout> | undefined;

  // Rebuild lifecycle — separate from isRebuilding in the store so the
  // status line can show a transient error.
  let rebuildError = $state(false);

  // Recent files (filename empty-state). Memoised by a signature of the
  // first-N reversed filePaths — tabStore emits on every per-tab field
  // change (dirty flag, scroll/cursor pos, lastSavedHash), and we must not
  // rebuild this list on each of those. #261.
  let recentFiles = $state<RecentEntry[]>([]);
  let recentFilesSig = "";

  // Current k cap for content-mode search_fulltext. Grows monotonically as
  // the user clicks "Mehr laden"; resets to the small default whenever the
  // query or mode changes (a new query is a new intent).
  let contentK = $state(CONTENT_SEARCH_INITIAL_K);

  // Reset state when the active vault changes — a filename hit from vault A
  // would otherwise still render after switching to vault B.
  let prevVaultPath: string | null = null;
  let vaultSubInitialised = false;
  const unsubVault = vaultStore.subscribe((state) => {
    if (!vaultSubInitialised) {
      vaultSubInitialised = true;
      prevVaultPath = state.currentPath;
      return;
    }
    if (state.currentPath !== prevVaultPath) {
      prevVaultPath = state.currentPath;
      query = "";
      fileResults = [];
      selectedIndex = 0;
      contentK = CONTENT_SEARCH_INITIAL_K;
    }
  });

  const unsubTab = tabStore.subscribe((state) => {
    // Cheap signature check first — short-circuit the common case where
    // the emission is an unrelated per-tab field flip (isDirty,
    // scrollPos, lastSavedHash) and the recents list is unchanged. Avoids
    // the Set + map allocation on the keystroke / auto-save hot path.
    const sig = recentsSignature(state.tabs);
    if (sig === recentFilesSig) return;
    recentFilesSig = sig;
    recentFiles = computeRecentFiles(state.tabs);
  });

  // Content-mode results + counts flow through searchStore so the
  // cross-vault reset + indexStale event subscription keep working.
  let storeState = $state({
    results: [] as SearchResult[],
    totalFiles: 0,
    isRebuilding: false,
  });
  const unsubStore = searchStore.subscribe((s) => {
    storeState = {
      results: s.results,
      totalFiles: s.totalFiles,
      isRebuilding: s.isRebuilding,
    };
  });

  // ── Open / mode transitions ────────────────────────────────────────

  let lastOpen = false;
  $effect(() => {
    if (open && !lastOpen) {
      // Transition closed → open. Reset per-session state, focus input,
      // maybe prefill + kick off auto-rebuild.
      mode = initialMode;
      query = initialQuery ?? "";
      fileResults = [];
      selectedIndex = 0;
      rebuildError = false;
      contentK = CONTENT_SEARCH_INITIAL_K;
      searchStore.setQuery(query);

      void tick().then(() => inputEl?.focus());

      // Auto-rebuild if the index is stale. No user click required.
      let indexStale = false;
      const u = searchStore.subscribe((s) => { indexStale = s.indexStale; });
      u();
      if (indexStale) void startRebuild();

      // Run the prefilled query in the correct mode.
      if (query.trim()) {
        if (mode === "filename") void runFilenameSearch(query);
        else void runContentSearch(query);
      }
    }
    lastOpen = open;
  });

  async function startRebuild() {
    if (storeState.isRebuilding) return;
    searchStore.setRebuilding(true);
    rebuildError = false;
    try {
      await rebuildIndex();
      searchStore.setIndexStale(false);
      searchStore.setRebuilding(false);
      // Refetch whichever mode the user is currently in against the fresh
      // index. Filename mode is unaffected by content-index freshness but
      // re-running is cheap.
      if (query.trim()) {
        if (mode === "content") void runContentSearch(query);
        else void runFilenameSearch(query);
      }
    } catch {
      searchStore.setRebuilding(false);
      rebuildError = true;
    }
  }

  function retryRebuild() {
    rebuildError = false;
    searchStore.setIndexStale(true);
    void startRebuild();
  }

  // ── Search dispatch ────────────────────────────────────────────────

  async function runFilenameSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) {
      fileResults = [];
      return;
    }
    try {
      fileResults = await searchFilename(trimmed, 20);
    } catch {
      fileResults = [];
    }
  }

  async function runContentSearch(q: string, k: number = contentK) {
    const trimmed = q.trim();
    contentSearchGen += 1;
    const myGen = contentSearchGen;
    if (!trimmed) {
      searchStore.clearResults();
      searchStore.setQuery("");
      return;
    }
    searchStore.setSearching(true);
    try {
      // #261 — k starts at CONTENT_SEARCH_INITIAL_K (viewport-sized) and
      // grows only when the user clicks "Mehr laden". Previously fixed at
      // k=100 which wasted IPC + backend scoring budget on every keystroke.
      const results = await searchFulltext(trimmed, k);
      if (myGen !== contentSearchGen) return;
      const uniqueFiles = new Set(results.map((r) => r.path)).size;
      searchStore.setResults(results, uniqueFiles);
    } catch (e) {
      if (myGen !== contentSearchGen) return;
      searchStore.setSearching(false);
      if (isVaultError(e) && e.kind === "IndexCorrupt") {
        searchStore.setIndexStale(true);
        // Kick an auto-rebuild on corruption, matching the auto-open path.
        void startRebuild();
      }
    }
  }

  function loadMoreContent() {
    // Grow the k cap and re-run immediately (bypass debounce — user
    // clicked, intent is explicit). The generation counter in
    // runContentSearch keeps any in-flight smaller-k request from
    // overwriting this larger one.
    contentK += CONTENT_SEARCH_K_INCREMENT;
    if (contentDebounce) {
      clearTimeout(contentDebounce);
      contentDebounce = undefined;
    }
    if (query.trim()) void runContentSearch(query, contentK);
  }

  function handleInput(e: Event) {
    // Use explicit value read instead of `bind:value`. Bind paired with a
    // store subscription that reassigns $state objects caused the caret to
    // snap back to position 0 on every re-render because Svelte's bind
    // writes `input.value = query` again after each update. See #174 UAT.
    query = (e.currentTarget as HTMLInputElement).value;
    selectedIndex = 0;
    if (mode === "filename") {
      void runFilenameSearch(query);
    } else {
      // New query = new intent → reset the load-more cap so the debounced
      // search uses the small default k, not a previously-expanded k.
      contentK = CONTENT_SEARCH_INITIAL_K;
      if (contentDebounce) clearTimeout(contentDebounce);
      contentDebounce = setTimeout(() => runContentSearch(query), 200);
    }
  }

  function setMode(next: OmniMode) {
    if (next === mode) return;
    mode = next;
    selectedIndex = 0;
    // Re-run the current query against the new mode so results update
    // immediately instead of requiring a keystroke. Mode flip also resets
    // the content-mode k cap — a fresh mode is fresh intent.
    if (next === "content") contentK = CONTENT_SEARCH_INITIAL_K;
    if (query.trim()) {
      if (next === "filename") void runFilenameSearch(query);
      else void runContentSearch(query);
    }
  }

  // ── Active list (what the keyboard + click paths target) ───────────

  const activeList = $derived.by(() => {
    if (mode === "filename") {
      if (query.trim()) return fileResults;
      return recentFiles.map<FileMatch>((r) => ({
        path: r.path,
        score: 0,
        matchIndices: [],
      }));
    }
    return storeState.results;
  });

  // ── Result actions ─────────────────────────────────────────────────

  function openFileResult(entry: FileMatch) {
    let absPath = entry.path;
    let currentPath: string | null = null;
    const u = vaultStore.subscribe((s) => { currentPath = s.currentPath; });
    u();
    if (currentPath && !entry.path.startsWith("/")) {
      absPath = currentPath + "/" + entry.path;
    }
    onOpenFile(absPath);
    onClose();
  }

  function openContentResult(r: SearchResult) {
    onOpenFile(r.path);
    const searchText =
      extractSnippetMatch(r.snippet) ?? query.split(" ")[0] ?? "";
    if (searchText.trim()) {
      scrollStore.requestScrollToMatch(r.path, searchText);
    }
    onClose();
  }

  function activateSelection() {
    const idx = selectedIndex;
    if (mode === "filename") {
      const hit = activeList[idx] as FileMatch | undefined;
      if (hit) openFileResult(hit);
    } else {
      const hit = activeList[idx] as SearchResult | undefined;
      if (hit) openContentResult(hit);
    }
  }

  function handleKey(e: KeyboardEvent) {
    const count = activeList.length;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (count === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % count;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + count) % count;
    } else if (e.key === "Enter") {
      e.preventDefault();
      activateSelection();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function getFilename(path: string): string {
    return path.split("/").pop() ?? path;
  }

  function keyForFileResult(fm: FileMatch): string {
    return fm.matchedAlias ? `${fm.path}|${fm.matchedAlias}` : fm.path;
  }

  onDestroy(() => {
    unsubTab();
    unsubVault();
    unsubStore();
    if (contentDebounce) clearTimeout(contentDebounce);
  });

  // ── Status line derivation ─────────────────────────────────────────
  const statusText = $derived.by(() => {
    if (rebuildError) return "Index-Neuaufbau fehlgeschlagen";
    if (storeState.isRebuilding) return "Index wird neu aufgebaut…";
    return "";
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-quick-switcher-backdrop vc-modal-scrim"
    onmousedown={backdropClick}
  >
    <div
      class="vc-quick-switcher-modal vc-modal-surface"
      role="dialog"
      aria-modal="true"
      aria-label="Suche"
    >
      <!-- Mode switcher (segmented control) -->
      <div class="vc-omni-modes" role="tablist" aria-label="Suchmodus">
        <button
          type="button"
          class="vc-omni-mode"
          class:vc-omni-mode--active={mode === "filename"}
          aria-pressed={mode === "filename"}
          data-omni-mode="filename"
          onclick={() => setMode("filename")}
        >Dateien</button>
        <button
          type="button"
          class="vc-omni-mode"
          class:vc-omni-mode--active={mode === "content"}
          aria-pressed={mode === "content"}
          data-omni-mode="content"
          onclick={() => setMode("content")}
        >Inhalt</button>
      </div>

      <input
        bind:this={inputEl}
        value={query}
        oninput={handleInput}
        onkeydown={handleKey}
        type="text"
        placeholder={mode === "filename" ? "Datei suchen…" : "Volltext suchen…"}
        class="vc-qs-input"
        aria-label={mode === "filename" ? "Dateiname suchen" : "Volltext suchen"}
        autocomplete="off"
        spellcheck="false"
      />

      {#if statusText}
        <p class="vc-omni-status" role="status" aria-live="polite">
          {statusText}
          {#if rebuildError}
            <!-- svelte-ignore a11y_invalid_attribute -->
            <a
              href="#"
              class="vc-omni-status-retry"
              onclick={(e) => { e.preventDefault(); retryRebuild(); }}
            >Erneut versuchen</a>
          {/if}
        </p>
      {/if}

      <div class="vc-qs-results" role="listbox" aria-label="Suchergebnisse">
        {#if mode === "filename"}
          {#if activeList.length === 0 && query.trim()}
            <p class="vc-qs-empty">Keine Dateien gefunden — anderen Begriff versuchen</p>
          {:else if activeList.length === 0 && !query.trim()}
            <p class="vc-qs-section-label">Zuletzt geöffnet</p>
            <p class="vc-qs-empty">Keine zuletzt geöffneten Dateien</p>
          {:else}
            {#if !query.trim()}
              <p class="vc-qs-section-label">Zuletzt geöffnet</p>
            {/if}
            {#each activeList as result, i (keyForFileResult(result as FileMatch))}
              {@const fm = result as FileMatch}
              <QuickSwitcherRow
                filename={getFilename(fm.path)}
                relativePath={fm.path}
                matchIndices={fm.matchIndices}
                matchedAlias={fm.matchedAlias}
                selected={i === selectedIndex}
                onclick={() => openFileResult(fm)}
                onhover={() => { selectedIndex = i; }}
              />
            {/each}
          {/if}
        {:else}
          {#if activeList.length === 0 && query.trim()}
            <p class="vc-qs-empty">Keine Treffer</p>
          {:else if activeList.length === 0}
            <p class="vc-qs-empty">Tippe, um im Volltext zu suchen</p>
          {:else}
            <p class="vc-search-results-counter">
              {storeState.results.length} Treffer in {storeState.totalFiles} Dateien
            </p>
            {#each activeList as result, i (`${(result as SearchResult).path}|${i}`)}
              <SearchResultRow
                result={result as SearchResult}
                onclick={() => openContentResult(result as SearchResult)}
              />
            {/each}
            {#if storeState.results.length >= contentK}
              <!-- #261 — the backend saturated the requested k, so there
                   may be more hits. Load-more grows k by an increment and
                   re-runs; we avoid fetching k=100 preemptively on every
                   keystroke. -->
              <button
                type="button"
                class="vc-omni-load-more"
                onclick={loadMoreContent}
              >Mehr laden</button>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .vc-quick-switcher-backdrop {
    z-index: 200;
  }

  .vc-quick-switcher-modal {
    width: 640px;
    max-height: 520px;
    position: fixed;
    top: 12%;
    left: 50%;
    transform: translateX(-50%);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    z-index: 201;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .vc-omni-modes {
    display: flex;
    gap: 4px;
    padding: 8px 8px 0 8px;
    border-bottom: 1px solid var(--color-border);
  }

  .vc-omni-mode {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--color-text-muted);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 6px 6px 0 0;
    cursor: pointer;
    /* #385 — fallback `auto` = no min-height constraint (initial value), so
       desktop sizing is padding-driven as before; coarse → 44px. */
    min-height: var(--vc-hit-target, auto);
  }

  .vc-omni-mode:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-omni-mode--active {
    color: var(--color-accent);
    border-bottom: 2px solid var(--color-accent);
    background: var(--color-accent-bg);
  }

  .vc-qs-input {
    width: 100%;
    height: 44px;
    padding: 0 16px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    font-size: 14px;
    outline: none;
    background: var(--color-surface);
    color: var(--color-text);
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .vc-qs-input::placeholder { color: var(--color-text-muted); }

  .vc-omni-status {
    margin: 0;
    padding: 6px 16px;
    font-size: 12px;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .vc-omni-status-retry {
    color: var(--color-accent);
    text-decoration: underline;
    cursor: pointer;
  }

  .vc-qs-results {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .vc-qs-section-label {
    font-size: 12px;
    color: var(--color-text-muted);
    padding: 8px 16px;
    margin: 0;
    font-weight: 600;
  }

  .vc-qs-empty {
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: center;
    padding: 16px;
    margin: 0;
  }

  .vc-omni-load-more {
    display: block;
    width: 100%;
    appearance: none;
    border: none;
    background: transparent;
    color: var(--color-accent);
    font-size: 12px;
    font-weight: 600;
    padding: 10px 16px;
    cursor: pointer;
    border-top: 1px solid var(--color-border);
  }

  .vc-omni-load-more:hover {
    background: var(--color-accent-bg);
  }

  .vc-search-results-counter {
    font-size: 12px;
    color: var(--color-text-muted);
    padding: 8px 16px;
    margin: 0;
    border-bottom: 1px solid var(--color-border);
  }
</style>
