<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ChevronDown, ChevronRight } from "lucide-svelte";
  import { activeViewStore } from "../../store/activeViewStore";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore } from "../../store/tabStore";
  import { getLocalGraph } from "../../ipc/commands";
  import { listenFileChange } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import type { LocalGraph } from "../../types/links";
  import {
    destroyGraph,
    mountGraph,
    setCenter,
    updateGraph,
    DEFAULT_FORCE_SETTINGS,
    type GraphHandle,
  } from "./graphRender";
  import AsciiSpinner from "../ascii/AsciiSpinner.svelte";

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
  let resizeObserver: ResizeObserver | null = null;

  // sigma needs a non-zero container — treat anything below this as "layout
  // not resolved yet" and wait for a ResizeObserver tick.
  const MIN_MOUNT_DIMENSION = 8;

  // Reactive active-tab / doc-version plumbing — driven by Svelte-store
  // auto-subscription so the derived chain actually re-runs on tab switch.
  // A classic `tabStore.subscribe(cb)` that writes into $state was silently
  // dropping updates after the initial mount, leaving the graph stuck on
  // the first note. OutgoingLinksPanel uses the same direct-$derived
  // pattern and behaves correctly.
  const activeRelPath = $derived.by<string | null>(() => {
    const s = $tabStore;
    const v = $vaultStore;
    if (!s.activeTabId || !v.currentPath) return null;
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab) return null;
    if (tab.filePath.startsWith(v.currentPath + "/")) {
      return tab.filePath.slice(v.currentPath.length + 1);
    }
    return null;
  });
  const vaultPath = $derived($vaultStore.currentPath);

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
    // have run yet; wait for the first ResizeObserver entry that reports a
    // usable width/height. rAF fires before layout so polling it just spins.
    if (
      canvasEl.clientWidth < MIN_MOUNT_DIMENSION ||
      canvasEl.clientHeight < MIN_MOUNT_DIMENSION
    ) {
      if (resizeObserver) return;
      const target = canvasEl;
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width >= MIN_MOUNT_DIMENSION && height >= MIN_MOUNT_DIMENSION) {
            resizeObserver?.disconnect();
            resizeObserver = null;
            tryMount();
            return;
          }
        }
      });
      resizeObserver.observe(target);
      return;
    }
    handle = mountGraph(canvasEl, graphData, {
      centerId: centerRel,
      accentColor: "var(--color-accent)",
      nodeColor: "var(--color-text-muted)",
      unresolvedColor: "var(--color-border)",
      edgeColor: "var(--color-border)",
      // Continuous / organic sim — same Obsidian-like feel as the global graph.
      // No Forces UI in the panel to keep it minimal; the defaults are tuned
      // for a small neighborhood view.
      forceSettings: DEFAULT_FORCE_SETTINGS,
      enableNodeDrag: true,
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
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
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
    unlistenFileChange?.();
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
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
        <div class="vc-graph-empty" aria-label="No file open">Keine Datei geöffnet.</div>
      {:else if errorMessage}
        <div class="vc-graph-empty">{errorMessage}</div>
      {:else}
        <!-- Always render the canvas when a note is open, even when the
             local graph has no edges. If we swap it out for a
             "Keine Verbindungen" message the bind:this=canvasEl element
             leaves the DOM and the live sigma handle is left pointing at a
             detached node; when the user switches back to a linked note the
             next mountGraph is called into a freshly inserted, zero-width
             div and Sigma logs 'Container has no width' (#43). Keeping the
             div in place lets updateGraph render the center-only graph,
             and we overlay a message when hasLinks is false. -->
        <div
          class="vc-graph-canvas"
          bind:this={canvasEl}
          title={centerRel ?? ""}
        ></div>
        {#if graphData && !hasLinks}
          <div
            class="vc-graph-no-links"
            aria-label="No outgoing or incoming links for this file"
          >Keine Verbindungen</div>
        {/if}
      {/if}
      {#if loading}
        <div class="vc-graph-loading" aria-label="Computing local graph">
          <AsciiSpinner /> Computing local graph
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .vc-graph-panel {
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
    height: 100%;
    min-height: 0;
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
    flex: 1 1 auto;
    min-height: 250px;
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
  .vc-graph-no-links {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    padding: 2px 8px;
    font-size: 11px;
    color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-surface) 80%, transparent);
    border-radius: 4px;
    pointer-events: none;
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
