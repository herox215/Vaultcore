<script lang="ts">
  // Canvas viewer — issue #71, phases 1 + 2.
  //
  // Phase 1: text cards (pan/zoom/create/edit/move/resize/delete) and
  // lossless roundtrip for all other node types through an `extra` bag.
  //
  // Phase 2: edges (#125). SVG overlay rides the same world transform as
  // the nodes. Every node exposes four hover handles (top/right/bottom/left);
  // dragging from a handle draws a preview bezier that snaps onto any other
  // node's handle to create an edge. Edges select on click (thick invisible
  // hit-path behind the visible stroke) and delete on Backspace/Delete.
  // Optional labels edit via double-click on the edge midpoint.

  import { onMount, onDestroy, tick } from "svelte";
  import { readFile, writeFile } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import {
    parseCanvas,
    serializeCanvas,
    emptyCanvas,
  } from "../../lib/canvas/parse";
  import type {
    CanvasDoc,
    CanvasEdge,
    CanvasNode,
    CanvasSide,
    CanvasTextNode,
  } from "../../lib/canvas/types";
  import {
    DEFAULT_NODE_WIDTH,
    DEFAULT_NODE_HEIGHT,
  } from "../../lib/canvas/types";
  import {
    SIDES,
    anchorPoint,
    autoSides,
    bezierMidpoint,
    bezierPath,
  } from "../../lib/canvas/geometry";

  interface Props {
    tabId: string;
    abs: string;
  }

  let { tabId, abs }: Props = $props();

  let doc = $state<CanvasDoc>(emptyCanvas());
  let loaded = $state(false);
  let loadError = $state<string | null>(null);

  let camX = $state(0);
  let camY = $state(0);
  let zoom = $state(1);

  let selectedNodeId = $state<string | null>(null);
  let selectedEdgeId = $state<string | null>(null);
  let editingNodeId = $state<string | null>(null);
  let editingEdgeId = $state<string | null>(null);
  let hoveredNodeId = $state<string | null>(null);

  // Draft edge: populated while the user drags from a handle. `targetNodeId`
  // + `targetSide` are only set when the pointer is over another node's
  // handle, which is when pointerup commits the edge.
  type DraftEdge = {
    fromNodeId: string;
    fromSide: CanvasSide;
    currentX: number;
    currentY: number;
    targetNodeId: string | null;
    targetSide: CanvasSide | null;
  };
  let draft = $state<DraftEdge | null>(null);

  let viewportEl: HTMLDivElement | null = null;
  let editingTextareaEl = $state<HTMLTextAreaElement | null>(null);
  let editingEdgeLabelEl = $state<HTMLInputElement | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWrittenJson = "";
  let suppressSave = true;
  let spaceHeld = $state(false);

  type PointerMode =
    | { kind: "pan"; startClientX: number; startClientY: number; startCamX: number; startCamY: number }
    | { kind: "move"; nodeId: string; startClientX: number; startClientY: number; startX: number; startY: number }
    | { kind: "resize"; nodeId: string; startClientX: number; startClientY: number; startW: number; startH: number }
    | { kind: "edge"; fromNodeId: string; fromSide: CanvasSide };

  let pointerMode: PointerMode | null = null;

  const MIN_ZOOM = 0.15;
  const MAX_ZOOM = 4;

  async function load() {
    try {
      const text = await readFile(abs);
      doc = parseCanvas(text);
      lastWrittenJson = serializeCanvas(doc);
    } catch (e) {
      const ve = isVaultError(e)
        ? e
        : { kind: "Io" as const, message: String(e), data: null };
      loadError = vaultErrorCopy(ve);
      toastStore.push({ variant: "error", message: loadError });
      doc = emptyCanvas();
      lastWrittenJson = serializeCanvas(doc);
    } finally {
      loaded = true;
      await tick();
      suppressSave = false;
    }
  }

  function scheduleSave() {
    if (suppressSave || !loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 400);
  }

  async function persist() {
    const serialized = serializeCanvas(doc);
    if (serialized === lastWrittenJson) return;
    try {
      await writeFile(abs, serialized);
      lastWrittenJson = serialized;
    } catch (e) {
      const ve = isVaultError(e)
        ? e
        : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void persist();
    }
  });

  $effect(() => {
    if (editingNodeId && editingTextareaEl) {
      editingTextareaEl.focus();
      editingTextareaEl.select();
    }
  });

  $effect(() => {
    if (editingEdgeId && editingEdgeLabelEl) {
      editingEdgeLabelEl.focus();
      editingEdgeLabelEl.select();
    }
  });

  $effect(() => {
    void doc.nodes.length;
    void doc.edges.length;
    for (const n of doc.nodes) {
      void n.x; void n.y; void n.width; void n.height;
      if (n.type === "text") void (n as CanvasTextNode).text;
    }
    for (const e of doc.edges) {
      void e.fromNode; void e.toNode; void e.fromSide; void e.toSide;
      void e.color; void e.label;
    }
    scheduleSave();
  });

  function clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    if (!viewportEl) return { x: 0, y: 0 };
    const rect = viewportEl.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    return { x: (vx - camX) / zoom, y: (vy - camY) / zoom };
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (!viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const worldX = (vx - camX) / zoom;
    const worldY = (vy - camY) / zoom;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    camX = vx - worldX * next;
    camY = vy - worldY * next;
    zoom = next;
  }

  function onViewportPointerDown(e: PointerEvent) {
    if (editingNodeId || editingEdgeId) return;
    const isPan = e.button === 1 || (e.button === 0 && spaceHeld);
    if (!isPan) return;
    e.preventDefault();
    selectedNodeId = null;
    selectedEdgeId = null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerMode = {
      kind: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCamX: camX,
      startCamY: camY,
    };
  }

  function onViewportPointerMove(e: PointerEvent) {
    if (!pointerMode) return;
    if (pointerMode.kind === "pan") {
      camX = pointerMode.startCamX + (e.clientX - pointerMode.startClientX);
      camY = pointerMode.startCamY + (e.clientY - pointerMode.startClientY);
    } else if (pointerMode.kind === "move") {
      const dx = (e.clientX - pointerMode.startClientX) / zoom;
      const dy = (e.clientY - pointerMode.startClientY) / zoom;
      const node = doc.nodes.find((n) => n.id === pointerMode!.nodeId);
      if (node) {
        node.x = pointerMode.startX + dx;
        node.y = pointerMode.startY + dy;
      }
    } else if (pointerMode.kind === "resize") {
      const dx = (e.clientX - pointerMode.startClientX) / zoom;
      const dy = (e.clientY - pointerMode.startClientY) / zoom;
      const node = doc.nodes.find((n) => n.id === pointerMode!.nodeId);
      if (node) {
        node.width = Math.max(80, pointerMode.startW + dx);
        node.height = Math.max(40, pointerMode.startH + dy);
      }
    } else if (pointerMode.kind === "edge" && draft) {
      const { x, y } = clientToWorld(e.clientX, e.clientY);
      draft.currentX = x;
      draft.currentY = y;
      const hit = handleAtPoint(e.clientX, e.clientY);
      if (hit && hit.nodeId !== draft.fromNodeId) {
        draft.targetNodeId = hit.nodeId;
        draft.targetSide = hit.side;
      } else {
        draft.targetNodeId = null;
        draft.targetSide = null;
      }
    }
  }

  function onViewportPointerUp(e: PointerEvent) {
    if (!pointerMode) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch { /* releasePointerCapture may throw in the synthetic test env */ }
    if (pointerMode.kind === "edge" && draft) {
      if (draft.targetNodeId && draft.targetSide) {
        commitDraftEdge(
          draft.fromNodeId,
          draft.fromSide,
          draft.targetNodeId,
          draft.targetSide,
        );
      }
      draft = null;
    }
    pointerMode = null;
  }

  function commitDraftEdge(
    fromId: string,
    fromSide: CanvasSide,
    toId: string,
    toSide: CanvasSide,
  ) {
    const edge: CanvasEdge = {
      id: crypto.randomUUID(),
      fromNode: fromId,
      toNode: toId,
      fromSide,
      toSide,
    };
    doc.edges = [...doc.edges, edge];
    selectedEdgeId = edge.id;
    selectedNodeId = null;
  }

  function onViewportDblClick(e: MouseEvent) {
    if (editingNodeId || editingEdgeId) return;
    const target = e.target as HTMLElement;
    if (target.closest(".vc-canvas-node")) return;
    if (target.closest(".vc-canvas-edge-hit")) return;
    if (target.closest(".vc-canvas-edge-label")) return;
    const { x, y } = clientToWorld(e.clientX, e.clientY);
    const node: CanvasTextNode = {
      id: crypto.randomUUID(),
      type: "text",
      x: x - DEFAULT_NODE_WIDTH / 2,
      y: y - DEFAULT_NODE_HEIGHT / 2,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      text: "",
    };
    doc.nodes = [...doc.nodes, node];
    selectedNodeId = node.id;
    selectedEdgeId = null;
    editingNodeId = node.id;
  }

  function onNodePointerDown(e: PointerEvent, node: CanvasNode) {
    if (editingNodeId === node.id) return;
    if (e.button !== 0 || spaceHeld) return;
    e.stopPropagation();
    selectedNodeId = node.id;
    selectedEdgeId = null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerMode = {
      kind: "move",
      nodeId: node.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: node.x,
      startY: node.y,
    };
  }

  function onNodeDblClick(e: MouseEvent, node: CanvasNode) {
    e.stopPropagation();
    if (node.type !== "text") return;
    editingNodeId = node.id;
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  function onResizePointerDown(e: PointerEvent, node: CanvasNode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    selectedNodeId = node.id;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerMode = {
      kind: "resize",
      nodeId: node.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startW: node.width,
      startH: node.height,
    };
  }

  function onHandlePointerDown(e: PointerEvent, node: CanvasNode, side: CanvasSide) {
    if (e.button !== 0 || spaceHeld) return;
    e.stopPropagation();
    e.preventDefault();
    const anchor = anchorPoint(node, side);
    draft = {
      fromNodeId: node.id,
      fromSide: side,
      currentX: anchor.x,
      currentY: anchor.y,
      targetNodeId: null,
      targetSide: null,
    };
    pointerMode = { kind: "edge", fromNodeId: node.id, fromSide: side };
    try {
      viewportEl?.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture throws for synthetic-test pointer IDs */
    }
  }

  function handleAtPoint(
    clientX: number,
    clientY: number,
  ): { nodeId: string; side: CanvasSide } | null {
    if (!viewportEl) return null;
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      if (!(el instanceof HTMLElement)) continue;
      if (!viewportEl.contains(el)) continue;
      const side = el.getAttribute("data-edge-handle");
      if (!side) continue;
      const nodeEl = el.closest<HTMLElement>("[data-node-id]");
      const nodeId = nodeEl?.getAttribute("data-node-id");
      if (!nodeId) continue;
      if (side === "top" || side === "right" || side === "bottom" || side === "left") {
        return { nodeId, side };
      }
    }
    return null;
  }

  function onTextEdit(e: Event, node: CanvasTextNode) {
    node.text = (e.target as HTMLTextAreaElement).value;
  }

  function onTextBlur() {
    editingNodeId = null;
  }

  function onEdgeHitPointerDown(e: PointerEvent, edge: CanvasEdge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectedEdgeId = edge.id;
    selectedNodeId = null;
  }

  function onEdgeDblClick(e: MouseEvent, edge: CanvasEdge) {
    e.stopPropagation();
    editingEdgeId = edge.id;
    selectedEdgeId = edge.id;
    selectedNodeId = null;
  }

  function onEdgeLabelInput(e: Event, edge: CanvasEdge) {
    const value = (e.target as HTMLInputElement).value;
    const target = doc.edges.find((x) => x.id === edge.id);
    if (!target) return;
    if (value === "") {
      delete target.label;
    } else {
      target.label = value;
    }
  }

  function onEdgeLabelBlur() {
    editingEdgeId = null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (editingNodeId || editingEdgeId) {
      if (e.key === "Escape") {
        e.preventDefault();
        editingNodeId = null;
        editingEdgeId = null;
      }
      return;
    }
    if (e.key === " " && !e.repeat) {
      spaceHeld = true;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedEdgeId) {
        e.preventDefault();
        doc.edges = doc.edges.filter((ed) => ed.id !== selectedEdgeId);
        selectedEdgeId = null;
        return;
      }
      if (selectedNodeId) {
        e.preventDefault();
        const id = selectedNodeId;
        doc.nodes = doc.nodes.filter((n) => n.id !== id);
        doc.edges = doc.edges.filter((ed) => ed.fromNode !== id && ed.toNode !== id);
        selectedNodeId = null;
      }
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.key === " ") spaceHeld = false;
  }

  // Resolved edge geometry for the render loop. An edge whose endpoint node
  // is missing from the doc (corrupt file, partial edit) is silently skipped
  // so the viewer keeps working rather than crashing.
  type ResolvedEdge = {
    edge: CanvasEdge;
    fromPt: { x: number; y: number };
    toPt: { x: number; y: number };
    fromSide: CanvasSide;
    toSide: CanvasSide;
    path: string;
    mid: { x: number; y: number };
  };

  function resolveEdges(): ResolvedEdge[] {
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    const out: ResolvedEdge[] = [];
    for (const edge of doc.edges) {
      const from = byId.get(edge.fromNode);
      const to = byId.get(edge.toNode);
      if (!from || !to) continue;
      const { fromSide, toSide } =
        edge.fromSide && edge.toSide
          ? { fromSide: edge.fromSide, toSide: edge.toSide }
          : autoSides(from, to);
      const fromPt = anchorPoint(from, fromSide);
      const toPt = anchorPoint(to, toSide);
      out.push({
        edge,
        fromPt,
        toPt,
        fromSide,
        toSide,
        path: bezierPath(fromPt, fromSide, toPt, toSide),
        mid: bezierMidpoint(fromPt, fromSide, toPt, toSide),
      });
    }
    return out;
  }

  let resolvedEdges = $derived(resolveEdges());

  function draftPath(): string | null {
    if (!draft) return null;
    const from = doc.nodes.find((n) => n.id === draft!.fromNodeId);
    if (!from) return null;
    const fromPt = anchorPoint(from, draft.fromSide);
    // If hovering a valid target handle, use that side for a natural entry;
    // otherwise aim straight at the cursor with an opposite-ish side.
    if (draft.targetNodeId && draft.targetSide) {
      const to = doc.nodes.find((n) => n.id === draft!.targetNodeId);
      if (to) {
        const toPt = anchorPoint(to, draft.targetSide);
        return bezierPath(fromPt, draft.fromSide, toPt, draft.targetSide);
      }
    }
    const toSide: CanvasSide =
      draft.fromSide === "left"
        ? "right"
        : draft.fromSide === "right"
          ? "left"
          : draft.fromSide === "top"
            ? "bottom"
            : "top";
    return bezierPath(
      fromPt,
      draft.fromSide,
      { x: draft.currentX, y: draft.currentY },
      toSide,
    );
  }

  let draftPathD = $derived(draftPath());
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<div
  class="vc-canvas-viewport"
  class:vc-canvas-panning={spaceHeld}
  class:vc-canvas-drafting={!!draft}
  bind:this={viewportEl}
  role="application"
  aria-label="Canvas"
  data-tab-id={tabId}
  onpointerdown={onViewportPointerDown}
  onpointermove={onViewportPointerMove}
  onpointerup={onViewportPointerUp}
  onpointercancel={onViewportPointerUp}
  ondblclick={onViewportDblClick}
  onwheel={onWheel}
>
  {#if !loaded}
    <div class="vc-canvas-loading">Loading canvas…</div>
  {:else if loadError}
    <div class="vc-canvas-error">{loadError}</div>
  {:else}
    <div
      class="vc-canvas-world"
      style:transform={`translate(${camX}px, ${camY}px) scale(${zoom})`}
    >
      <svg
        class="vc-canvas-edges"
        overflow="visible"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="vc-canvas-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {#each resolvedEdges as re (re.edge.id)}
          {@const arrowEnd = re.edge.toEnd !== "none"}
          {@const arrowStart = re.edge.fromEnd === "arrow"}
          <!-- Wide invisible hit target (svg captures pointer events) -->
          <path
            class="vc-canvas-edge-hit"
            d={re.path}
            data-edge-id={re.edge.id}
            onpointerdown={(e) => onEdgeHitPointerDown(e, re.edge)}
            ondblclick={(e) => onEdgeDblClick(e, re.edge)}
          />
          <path
            class="vc-canvas-edge"
            class:vc-canvas-edge-selected={selectedEdgeId === re.edge.id}
            d={re.path}
            style:color={re.edge.color ?? "var(--color-border-strong, #9ca3af)"}
            marker-end={arrowEnd ? "url(#vc-canvas-arrow)" : null}
            marker-start={arrowStart ? "url(#vc-canvas-arrow)" : null}
            data-edge-id={re.edge.id}
          />
        {/each}
        {#if draftPathD}
          <path
            class="vc-canvas-edge-draft"
            d={draftPathD}
          />
        {/if}
      </svg>

      {#each resolvedEdges as re (`lbl-${re.edge.id}`)}
        {#if editingEdgeId === re.edge.id}
          <input
            bind:this={editingEdgeLabelEl}
            class="vc-canvas-edge-label-input"
            value={re.edge.label ?? ""}
            style:left={`${re.mid.x}px`}
            style:top={`${re.mid.y}px`}
            oninput={(e) => onEdgeLabelInput(e, re.edge)}
            onblur={onEdgeLabelBlur}
            onpointerdown={(e) => e.stopPropagation()}
            ondblclick={(e) => e.stopPropagation()}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                editingEdgeId = null;
              }
            }}
          />
        {:else if re.edge.label}
          <div
            class="vc-canvas-edge-label"
            class:vc-canvas-edge-label-selected={selectedEdgeId === re.edge.id}
            style:left={`${re.mid.x}px`}
            style:top={`${re.mid.y}px`}
            data-edge-id={re.edge.id}
            onpointerdown={(e) => onEdgeHitPointerDown(e, re.edge)}
            ondblclick={(e) => onEdgeDblClick(e, re.edge)}
            role="button"
            tabindex="0"
          >
            {re.edge.label}
          </div>
        {/if}
      {/each}

      {#each doc.nodes as node (node.id)}
        {#if node.type === "text"}
          <div
            class="vc-canvas-node vc-canvas-node-text"
            class:vc-canvas-node-selected={selectedNodeId === node.id}
            class:vc-canvas-node-editing={editingNodeId === node.id}
            class:vc-canvas-node-hovered={hoveredNodeId === node.id || draft?.fromNodeId === node.id}
            style:left={`${node.x}px`}
            style:top={`${node.y}px`}
            style:width={`${node.width}px`}
            style:height={`${node.height}px`}
            data-node-id={node.id}
            onpointerdown={(e) => onNodePointerDown(e, node)}
            ondblclick={(e) => onNodeDblClick(e, node)}
            onpointerenter={() => (hoveredNodeId = node.id)}
            onpointerleave={() => {
              if (hoveredNodeId === node.id) hoveredNodeId = null;
            }}
            role="button"
            tabindex="0"
          >
            {#if editingNodeId === node.id}
              <textarea
                bind:this={editingTextareaEl}
                class="vc-canvas-node-textarea"
                value={(node as CanvasTextNode).text}
                oninput={(e) => onTextEdit(e, node as CanvasTextNode)}
                onblur={onTextBlur}
                onpointerdown={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
              ></textarea>
            {:else}
              <div class="vc-canvas-node-content">
                {(node as CanvasTextNode).text || "Empty card"}
              </div>
            {/if}
            <div
              class="vc-canvas-resize-handle"
              onpointerdown={(e) => onResizePointerDown(e, node)}
              role="presentation"
            ></div>
            {#each SIDES as side (side)}
              <button
                type="button"
                class="vc-canvas-edge-handle vc-canvas-edge-handle-{side}"
                class:vc-canvas-edge-handle-active={draft?.targetNodeId === node.id && draft?.targetSide === side}
                aria-label={`Create edge from ${side}`}
                data-edge-handle={side}
                onpointerdown={(e) => onHandlePointerDown(e, node, side)}
              ></button>
            {/each}
          </div>
        {:else}
          <div
            class="vc-canvas-node vc-canvas-node-placeholder"
            class:vc-canvas-node-selected={selectedNodeId === node.id}
            class:vc-canvas-node-hovered={hoveredNodeId === node.id || draft?.fromNodeId === node.id}
            style:left={`${node.x}px`}
            style:top={`${node.y}px`}
            style:width={`${node.width}px`}
            style:height={`${node.height}px`}
            data-node-id={node.id}
            onpointerdown={(e) => onNodePointerDown(e, node)}
            onpointerenter={() => (hoveredNodeId = node.id)}
            onpointerleave={() => {
              if (hoveredNodeId === node.id) hoveredNodeId = null;
            }}
            role="button"
            tabindex="0"
          >
            <div class="vc-canvas-node-content">
              <em>{node.type}</em>
            </div>
            {#each SIDES as side (side)}
              <button
                type="button"
                class="vc-canvas-edge-handle vc-canvas-edge-handle-{side}"
                class:vc-canvas-edge-handle-active={draft?.targetNodeId === node.id && draft?.targetSide === side}
                aria-label={`Create edge from ${side}`}
                data-edge-handle={side}
                onpointerdown={(e) => onHandlePointerDown(e, node, side)}
              ></button>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .vc-canvas-viewport {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--color-bg);
    background-image: radial-gradient(var(--color-border) 1px, transparent 1px);
    background-size: 24px 24px;
    touch-action: none;
    user-select: none;
  }

  .vc-canvas-panning {
    cursor: grab;
  }

  .vc-canvas-drafting {
    cursor: crosshair;
  }

  .vc-canvas-world {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
  }

  .vc-canvas-edges {
    position: absolute;
    left: 0;
    top: 0;
    width: 1px;
    height: 1px;
    overflow: visible;
    pointer-events: none;
    color: var(--color-border-strong, #9ca3af);
  }

  .vc-canvas-edge {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    pointer-events: none;
  }

  .vc-canvas-edge-selected {
    stroke: var(--color-accent);
    stroke-width: 3;
  }

  .vc-canvas-edge-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 14;
    pointer-events: stroke;
    cursor: pointer;
  }

  .vc-canvas-edge-draft {
    fill: none;
    stroke: var(--color-accent);
    stroke-width: 2;
    stroke-dasharray: 6 4;
    pointer-events: none;
    opacity: 0.9;
  }

  .vc-canvas-edge-label {
    position: absolute;
    transform: translate(-50%, -50%);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 12px;
    color: var(--color-text);
    white-space: nowrap;
    pointer-events: auto;
    cursor: pointer;
  }

  .vc-canvas-edge-label-selected {
    border-color: var(--color-accent);
  }

  .vc-canvas-edge-label-input {
    position: absolute;
    transform: translate(-50%, -50%);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 12px;
    font-family: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    outline: none;
    min-width: 80px;
  }

  .vc-canvas-node {
    position: absolute;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
    overflow: visible;
    cursor: move;
  }

  .vc-canvas-node-selected {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-accent-bg);
  }

  .vc-canvas-node-content {
    padding: 8px;
    font-size: 14px;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    flex: 1;
    overflow: auto;
  }

  .vc-canvas-node-placeholder .vc-canvas-node-content {
    color: var(--color-text-muted);
    font-style: italic;
  }

  .vc-canvas-node-textarea {
    flex: 1;
    resize: none;
    border: none;
    outline: none;
    padding: 8px;
    font-size: 14px;
    font-family: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    box-sizing: border-box;
  }

  .vc-canvas-resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 12px;
    height: 12px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--color-border) 50%
    );
    z-index: 1;
  }

  .vc-canvas-edge-handle {
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-accent);
    border: 2px solid var(--color-surface);
    padding: 0;
    cursor: crosshair;
    opacity: 0;
    transition: opacity 90ms ease-out;
    z-index: 2;
  }

  .vc-canvas-node-hovered .vc-canvas-edge-handle,
  .vc-canvas-drafting .vc-canvas-edge-handle {
    opacity: 1;
  }

  .vc-canvas-edge-handle-active {
    box-shadow: 0 0 0 3px var(--color-accent-bg);
    opacity: 1;
  }

  .vc-canvas-edge-handle-top {
    left: 50%;
    top: 0;
    transform: translate(-50%, -50%);
  }

  .vc-canvas-edge-handle-right {
    right: 0;
    top: 50%;
    transform: translate(50%, -50%);
  }

  .vc-canvas-edge-handle-bottom {
    left: 50%;
    bottom: 0;
    transform: translate(-50%, 50%);
  }

  .vc-canvas-edge-handle-left {
    left: 0;
    top: 50%;
    transform: translate(-50%, -50%);
  }

  .vc-canvas-loading,
  .vc-canvas-error {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }

  .vc-canvas-error {
    color: var(--color-error);
  }
</style>
