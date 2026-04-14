<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ChevronDown, ChevronRight } from "lucide-svelte";
  import { activeViewStore } from "../../store/activeViewStore";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore, type Tab } from "../../store/tabStore";
  import { getLocalGraph } from "../../ipc/commands";
  import { listenFileChange } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import type { LocalGraph } from "../../types/links";
  import {
    destroyGraph,
    mountGraph,
    setCenter,
    updateGraph,
    type GraphHandle,
  } from "./graphRender";

  const STORAGE_KEY_COLLAPSED = "vaultcore-graph-collapsed";
  const DEBOUNCE_MS = 200;
  const DEPTH = 1;

  function loadCollapsed(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY_COLLAPSED) === "true";
    } catch {
      return false;
    }
  }

  let collapsed = $state<boolean>(loadCollapsed());
  let graphData = $state<LocalGraph | null>(null);
  let loading = $state<boolean>(false);
  let errorMessage = $state<string | null>(null);
  let canvasEl = $state<HTMLDivElement | undefined>();

  // The vault-relative path of the CURRENT center note. Starts out equal
  // to the active tab's vault-relative path; double-click on a node moves
  // the center without changing the open tab.
  let centerRel = $state<string | null>(null);

  let handle: GraphHandle | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let unlistenFileChange: UnlistenFn | null = null;

  // Reactive active-tab / doc-version plumbing mirrors OutgoingLinksPanel.
  let tabs = $state<Tab[]>([]);
  let activeTabId = $state<string | null>(null);
  let vaultPath = $state<string | null>(null);

  const unsubTabs = tabStore.subscribe((s) => {
    tabs = s.tabs;
    activeTabId = s.activeTabId;
  });
  const unsubVault = vaultStore.subscribe((s) => {
    vaultPath = s.currentPath;
  });

  // Compute the vault-relative path of the active tab. Returns null when
  // no tab is active or the filePath doesn't sit under the vault root.
  const activeRelPath = $derived.by<string | null>(() => {
    if (!activeTabId || !vaultPath) return null;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return null;
    if (tab.filePath.startsWith(vaultPath + "/")) {
      return tab.filePath.slice(vaultPath.length + 1);
    }
    return null;
  });

  // When the active tab changes, reset the center to the active file.
  $effect(() => {
    centerRel = activeRelPath;
  });

  // docVersion bumps while editing — debounced re-fetch so link edits
  // propagate within ~200ms.
  const docVersion = $derived($activeViewStore.docVersion);

  $effect(() => {
    void docVersion;
    void centerRel;
    scheduleFetch();
  });

  function scheduleFetch(): void {
    if (collapsed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refetch();
    }, DEBOUNCE_MS);
  }

  async function refetch(): Promise<void> {
    if (!centerRel) {
      graphData = null;
      if (handle) {
        updateGraph(handle, { nodes: [], edges: [] });
      }
      return;
    }
    loading = true;
    errorMessage = null;
    try {
      const data = await getLocalGraph(centerRel, DEPTH);
      graphData = data;
      if (handle) {
        handle.options = { ...handle.options, centerId: centerRel };
        updateGraph(handle, data);
      } else {
        tryMount();
      }
    } catch (err) {
      errorMessage =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Graph konnte nicht geladen werden.";
      graphData = null;
    } finally {
      loading = false;
    }
  }

  function tryMount(): void {
    if (handle) return;
    if (!canvasEl || !graphData || !centerRel) return;
    // sigma measures the container on construct — make sure it has a size
    // before we mount. When the panel just opened the layout tick might not
    // have run yet; defer until next frame if clientWidth is still 0.
    if (canvasEl.clientWidth === 0 || canvasEl.clientHeight === 0) {
      requestAnimationFrame(tryMount);
      return;
    }
    handle = mountGraph(canvasEl, graphData, {
      centerId: centerRel,
      accentColor: "var(--color-accent)",
      nodeColor: "var(--color-text-muted)",
      unresolvedColor: "var(--color-border)",
      edgeColor: "var(--color-border)",
      onNodeClick: (id, node) => {
        if (!node.resolved || !vaultPath) return;
        tabStore.openTab(`${vaultPath}/${node.path}`);
      },
      onNodeDoubleClick: (id, node) => {
        if (!node.resolved) return;
        centerRel = node.path || id;
        setCenter(handle!, centerRel);
        scheduleFetch();
      },
    });
  }

  // Mount/unmount sigma as the panel expands or collapses.
  $effect(() => {
    if (collapsed) {
      if (handle) {
        destroyGraph(handle);
        handle = null;
      }
    } else if (graphData && !handle) {
      tryMount();
    }
  });

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));
    } catch {
      /* ignore */
    }
    if (!collapsed) {
      // Expanded — make sure we have fresh data.
      scheduleFetch();
    }
  }

  onMount(async () => {
    unlistenFileChange = await listenFileChange((payload) => {
      if (
        payload.kind === "create" ||
        payload.kind === "delete" ||
        payload.kind === "rename"
      ) {
        scheduleFetch();
      }
    });
    // Initial fetch — effect above may already have scheduled one but an
    // explicit call covers the case where the vault was already open on mount.
    if (centerRel) scheduleFetch();
  });

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    unsubTabs();
    unsubVault();
    unlistenFileChange?.();
    if (handle) {
      destroyGraph(handle);
      handle = null;
    }
  });

  // Convenience derived for the empty-state text.
  const hasNote = $derived(centerRel !== null);
  const hasLinks = $derived(
    graphData !== null && graphData.edges.length > 0,
  );
  const nodeCount = $derived(graphData?.nodes.length ?? 0);
</script>

<div class="vc-graph-panel" role="complementary" aria-label="Local Graph">
  <button
    type="button"
    class="vc-graph-header"
    aria-expanded={!collapsed}
    onclick={toggleCollapsed}
    title={centerRel ?? ""}
  >
    {#if collapsed}
      <ChevronRight size={14} />
    {:else}
      <ChevronDown size={14} />
    {/if}
    <span class="vc-graph-label">Local Graph</span>
    {#if !collapsed && nodeCount > 0}
      <span class="vc-graph-count">{nodeCount}</span>
    {/if}
  </button>

  {#if !collapsed}
    <div class="vc-graph-body">
      {#if !hasNote}
        <div class="vc-graph-empty">Keine Datei geöffnet.</div>
      {:else if errorMessage}
        <div class="vc-graph-empty">{errorMessage}</div>
      {:else if graphData && !hasLinks}
        <div class="vc-graph-empty">Keine Verbindungen</div>
      {:else}
        <div
          class="vc-graph-canvas"
          bind:this={canvasEl}
          title={centerRel ?? ""}
        ></div>
      {/if}
      {#if loading}
        <div class="vc-graph-loading">…</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .vc-graph-panel {
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
  }
  .vc-graph-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 16px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    width: 100%;
    text-align: left;
  }
  .vc-graph-header:hover {
    color: var(--color-accent);
  }
  .vc-graph-label {
    font-size: 12px;
    font-weight: 600;
    flex: 1;
  }
  .vc-graph-count {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-muted);
  }
  .vc-graph-body {
    position: relative;
    flex: 0 0 auto;
    height: 250px;
    overflow: hidden;
  }
  .vc-graph-canvas {
    width: 100%;
    height: 100%;
    position: relative;
  }
  .vc-graph-empty {
    padding: 24px 16px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }
  .vc-graph-loading {
    position: absolute;
    top: 6px;
    right: 10px;
    font-size: 11px;
    color: var(--color-text-muted);
    pointer-events: none;
  }
</style>
