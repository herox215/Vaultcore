<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    destroyGraph,
    mountGraph,
    updateGraph,
    type GraphHandle,
  } from "./graphRender";
  import type { LocalGraph, GraphNode } from "../../types/links";

  // Camera state persisted by the parent GraphView via localStorage — passed
  // in as a prop so the canvas stays agnostic of persistence keys.
  interface SavedCamera {
    x: number;
    y: number;
    ratio: number;
    angle: number;
  }

  interface Props {
    data: LocalGraph | null;
    activeId: string | null;
    savedCamera: SavedCamera | null;
    dimForNode: (id: string, attrs: Record<string, unknown>) => number | undefined;
    alwaysShowLabel?: (id: string) => boolean;
    onNodeClick: (id: string, node: GraphNode) => void;
    onCameraChange?: (cam: SavedCamera) => void;
    /** Bumped by the parent when the underlying vault identity changes so
     *  we re-run the force layout from scratch. Identity unchanged =
     *  keep positions, only refresh topology. */
    datasetVersion: number;
  }

  let {
    data,
    activeId,
    savedCamera,
    dimForNode,
    alwaysShowLabel,
    onNodeClick,
    onCameraChange,
    datasetVersion,
  }: Props = $props();

  let canvasEl = $state<HTMLDivElement | undefined>();
  let handle: GraphHandle | null = null;
  let lastDatasetVersion = -1;

  function restoreCamera(): void {
    if (!handle || !savedCamera) return;
    try {
      handle.renderer.getCamera().setState({
        x: savedCamera.x,
        y: savedCamera.y,
        ratio: savedCamera.ratio,
        angle: savedCamera.angle,
      });
    } catch {
      /* ignore */
    }
  }

  function tryMount(): void {
    if (handle) return;
    if (!canvasEl || !data) return;
    if (canvasEl.clientWidth === 0 || canvasEl.clientHeight === 0) {
      requestAnimationFrame(tryMount);
      return;
    }
    handle = mountGraph(canvasEl, data, {
      centerId: activeId,
      accentColor: "var(--color-accent)",
      nodeColor: "var(--color-text-muted)",
      unresolvedColor: "var(--color-border)",
      edgeColor: "var(--color-border)",
      layoutIterations: 300,
      enableNodeDrag: true,
      dimForNode,
      alwaysShowLabel,
      onNodeClick,
      onStageDoubleClick: () => {
        if (!handle) return;
        // Fit camera to graph extents.
        try {
          handle.renderer.getCamera().animatedReset({ duration: 300 });
        } catch {
          /* ignore */
        }
      },
    });
    lastDatasetVersion = datasetVersion;

    restoreCamera();

    // Persist camera on every change.
    if (onCameraChange) {
      const cam = handle.renderer.getCamera();
      const onUpdated = () => {
        const s = cam.getState();
        onCameraChange({ x: s.x, y: s.y, ratio: s.ratio, angle: s.angle });
      };
      cam.on("updated", onUpdated);
      handle.disposers.push(() => {
        try {
          cam.removeListener("updated", onUpdated);
        } catch {
          /* ignore */
        }
      });
    }
  }

  // Mount when the canvas gets sized + data arrives.
  $effect(() => {
    if (data && !handle) {
      tryMount();
    }
  });

  // Topology refresh — keep existing positions unless the dataset identity
  // (vault) changed.
  $effect(() => {
    if (!handle || !data) return;
    const versionChanged = datasetVersion !== lastDatasetVersion;
    handle.options = { ...handle.options, centerId: activeId, dimForNode, alwaysShowLabel, onNodeClick };
    updateGraph(handle, data, {
      relayout: versionChanged,
      iterations: versionChanged ? 300 : 30,
    });
    lastDatasetVersion = datasetVersion;
  });

  // activeId-only changes → just refresh reducers.
  $effect(() => {
    if (!handle) return;
    handle.options = { ...handle.options, centerId: activeId };
    handle.renderer.refresh({ skipIndexation: true });
  });

  onMount(() => {
    tryMount();
  });

  onDestroy(() => {
    if (handle) {
      destroyGraph(handle);
      handle = null;
    }
  });
</script>

<div class="vc-graph-canvas" bind:this={canvasEl}></div>

<style>
  .vc-graph-canvas {
    width: 100%;
    height: 100%;
    position: relative;
    background: var(--color-bg);
  }
</style>
