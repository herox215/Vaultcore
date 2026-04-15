<script lang="ts">
  import { onMount, tick } from "svelte";
  import { tabStore } from "../../store/tabStore";
  import { vaultStore } from "../../store/vaultStore";
  import { searchFilename } from "../../ipc/commands";
  import type { FileMatch } from "../../types/search";
  import QuickSwitcherRow from "./QuickSwitcherRow.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    onOpenFile: (path: string) => void;
  }

  let { open, onClose, onOpenFile }: Props = $props();

  let query = $state("");
  let results = $state<FileMatch[]>([]);
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>();

  // Recently opened files from tabStore (for empty-query state)
  let recentFiles = $state<Array<{ filename: string; path: string }>>([]);

  // Issue #46: clear stale query + results when the active vault changes.
  // The modal retains local state across open/close, so a filename search
  // run in Vault A would otherwise still render its old hits after
  // switching to Vault B (hits pointing to files outside the new root).
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
      results = [];
      selectedIndex = 0;
    }
  });

  // Subscribe to tabStore for recents
  const unsubTab = tabStore.subscribe((state) => {
    // Extract unique file paths from tabs, take last 8
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const tab of [...state.tabs].reverse()) {
      if (!seen.has(tab.filePath)) {
        seen.add(tab.filePath);
        unique.push(tab.filePath);
      }
      if (unique.length >= 8) break;
    }
    recentFiles = unique.map((p) => ({
      path: p,
      filename: p.split("/").pop() ?? p,
    }));
  });

  // The active result list (recents or fuzzy results)
  const activeResults = $derived(query.trim() ? results : recentFiles.map((r) => ({
    path: r.path,
    score: 0,
    matchIndices: [],
  } as FileMatch)));

  // Auto-focus input when modal opens
  $effect(() => {
    if (open) {
      query = "";
      results = [];
      selectedIndex = 0;
      void tick().then(() => inputEl?.focus());
    }
  });

  async function handleInput() {
    selectedIndex = 0;
    const q = query.trim();
    if (!q) {
      results = [];
      return;
    }
    // No debounce — nucleo runs in <10ms (T-03-11 accepted)
    try {
      results = await searchFilename(q, 20);
    } catch (_) {
      results = [];
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const count = activeResults.length;
    if (count === 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % count;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + count) % count;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = activeResults[selectedIndex];
      if (selected) {
        openResult(selected);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // Focus trap — prevent tab from leaving modal
      e.preventDefault();
    }
  }

  function openResult(result: FileMatch) {
    // Resolve to absolute path: prepend vault currentPath if path is relative
    let absPath = result.path;
    let currentPath: string | null = null;
    const unsub = vaultStore.subscribe((s) => { currentPath = s.currentPath; });
    unsub();
    if (currentPath && !result.path.startsWith("/")) {
      absPath = currentPath + "/" + result.path;
    }
    onOpenFile(absPath);
    onClose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }

  // Derive filename from path for display
  function getFilename(path: string): string {
    return path.split("/").pop() ?? path;
  }

  import { onDestroy } from "svelte";
  onDestroy(() => {
    unsubTab();
    unsubVault();
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-quick-switcher-backdrop"
    onclick={handleBackdropClick}
  >
    <!-- Modal card -->
    <div
      class="vc-quick-switcher-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Schnellwechsler"
    >
      <!-- Search input -->
      <input
        bind:this={inputEl}
        bind:value={query}
        oninput={handleInput}
        onkeydown={handleKeydown}
        type="text"
        placeholder="Datei suchen..."
        class="vc-qs-input"
        aria-label="Dateiname suchen"
        autocomplete="off"
        spellcheck="false"
      />

      <!-- Result list -->
      <div class="vc-qs-results" role="listbox" aria-label="Suchergebnisse">
        {#if activeResults.length === 0 && query.trim()}
          <!-- No results state -->
          <p class="vc-qs-empty">Keine Dateien gefunden — anderen Begriff versuchen</p>
        {:else if activeResults.length === 0 && !query.trim()}
          <!-- Empty recents state -->
          <p class="vc-qs-section-label">Zuletzt geöffnet</p>
          <p class="vc-qs-empty">Keine zuletzt geöffneten Dateien</p>
        {:else}
          {#if !query.trim()}
            <p class="vc-qs-section-label">Zuletzt geöffnet</p>
          {/if}
          {#each activeResults as result, i (result.path)}
            <QuickSwitcherRow
              filename={getFilename(result.path)}
              relativePath={result.path}
              matchIndices={result.matchIndices}
              selected={i === selectedIndex}
              onclick={() => openResult(result)}
              onhover={() => { selectedIndex = i; }}
            />
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .vc-quick-switcher-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 200;
  }

  .vc-quick-switcher-modal {
    width: 560px;
    max-height: 480px;
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    z-index: 201;
    display: flex;
    flex-direction: column;
    overflow: hidden;
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

  .vc-qs-input::placeholder {
    color: var(--color-text-muted);
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
</style>
