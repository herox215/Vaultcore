<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { activeViewStore } from "../../store/activeViewStore";
  import { getLocalGraph } from "../../ipc/commands";
  import { listenFileChange } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import type { LocalGraph } from "../../types/links";
  import {
    destroyGraph,
    mountGraph,
    updateGraph,
    DEFAULT_FORCE_SETTINGS,
    type GraphHandle,
  } from "../Graph/graphRender";

  let {
    visible,
    relPath,
  }: {
    visible: boolean;
    relPath: string | null;
  } = $props();

  const DEBOUNCE_MS = 200;
  const DEPTH = 1;
  const MIN_MOUNT_DIMENSION = 8;

  let graphData = $state<LocalGraph | null>(null);
  let canvasEl = $state<HTMLDivElement | undefined>();

  let handle: GraphHandle | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let unlistenFC: UnlistenFn | null = null;
  let resizeObs: ResizeObserver | null = null;

  const docVersion = $derived($activeViewStore.docVersion);

  $effect(() => {
    void docVersion;
    void relPath;
    if (visible) scheduleFetch();
  });

  $effect(() => {
    if (!visible) {
      teardown();
    } else if (graphData && !handle) {
      tryMount();
    }
  });

  function teardown(): void {
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (handle) {
      destroyGraph(handle);
      handle = null;
    }
  }

  function scheduleFetch(): void {
    if (!visible) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refetch();
    }, DEBOUNCE_MS);
  }

  async function refetch(): Promise<void> {
    if (!relPath) {
      graphData = null;
      if (handle) updateGraph(handle, { nodes: [], edges: [] });
      return;
    }
    try {
      const data = await getLocalGraph(relPath, DEPTH);
      graphData = data;
      if (handle) {
        handle.options = { ...handle.options, centerId: relPath };
        updateGraph(handle, data);
      } else {
        tryMount();
      }
    } catch {
      graphData = null;
    }
  }

  function tryMount(): void {
    if (handle || !canvasEl || !graphData || !relPath) return;
    if (
      canvasEl.clientWidth < MIN_MOUNT_DIMENSION ||
      canvasEl.clientHeight < MIN_MOUNT_DIMENSION
    ) {
      if (resizeObs) return;
      const target = canvasEl;
      resizeObs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width >= MIN_MOUNT_DIMENSION && height >= MIN_MOUNT_DIMENSION) {
            resizeObs?.disconnect();
            resizeObs = null;
            tryMount();
            return;
          }
        }
      });
      resizeObs.observe(target);
      return;
    }
    handle = mountGraph(canvasEl, graphData, {
      centerId: relPath,
      accentColor: "var(--color-accent)",
      nodeColor: "var(--color-text-muted)",
      unresolvedColor: "var(--color-border)",
      edgeColor: "var(--color-border)",
      forceSettings: DEFAULT_FORCE_SETTINGS,
      enableNodeDrag: false,
      renderLabels: false,
    });
  }

  onMount(async () => {
    unlistenFC = await listenFileChange((payload) => {
      if (
        payload.kind === "create" ||
        payload.kind === "delete" ||
        payload.kind === "rename"
      ) {
        scheduleFetch();
      }
    });
    if (visible && relPath) scheduleFetch();
  });

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    unlistenFC?.();
    teardown();
  });
</script>

{#if visible}
  <div class="vc-editor-graph-bg" bind:this={canvasEl}></div>
{/if}

<style>
  .vc-editor-graph-bg {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
  }
</style>
