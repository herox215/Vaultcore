<script lang="ts">
  // Canvas viewer — issue #71, phase 1.
  //
  // Scope: text cards only. Pan (middle/space+drag), zoom (wheel), create
  // (double-click empty space), edit (double-click card), move (drag body),
  // resize (drag SE handle), delete (Del/Backspace with card selected),
  // autosave to disk debounced through writeFile. Other node types (file,
  // link, group) are parsed and re-serialized unchanged so Obsidian canvases
  // open and save without losing data.

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
    CanvasNode,
    CanvasTextNode,
  } from "../../lib/canvas/types";
  import {
    DEFAULT_NODE_WIDTH,
    DEFAULT_NODE_HEIGHT,
  } from "../../lib/canvas/types";

  interface Props {
    tabId: string;
    abs: string;
  }

  let { tabId, abs }: Props = $props();

  let doc = $state<CanvasDoc>(emptyCanvas());
  let loaded = $state(false);
  let loadError = $state<string | null>(null);

  // Camera — world-space translation + zoom factor.
  let camX = $state(0);
  let camY = $state(0);
  let zoom = $state(1);

  let selectedId = $state<string | null>(null);
  let editingId = $state<string | null>(null);

  let viewportEl: HTMLDivElement | null = null;
  let editingTextareaEl: HTMLTextAreaElement | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWrittenJson = "";
  let suppressSave = true;
  let spaceHeld = $state(false);

  type PointerMode =
    | { kind: "pan"; startClientX: number; startClientY: number; startCamX: number; startCamY: number }
    | { kind: "move"; nodeId: string; startClientX: number; startClientY: number; startX: number; startY: number }
    | { kind: "resize"; nodeId: string; startClientX: number; startClientY: number; startW: number; startH: number };

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

  async function flushPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await persist();
    }
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      // Fire-and-forget — we can't await in onDestroy but we've already
      // debounced, so the window for loss is small.
      void persist();
    }
  });

  // Focus the textarea once it mounts — replaces the `autofocus` attribute
  // which Svelte 5 warns about for accessibility reasons.
  $effect(() => {
    if (editingId && editingTextareaEl) {
      editingTextareaEl.focus();
      editingTextareaEl.select();
    }
  });

  // Trigger autosave whenever the doc changes post-load. Serializing on
  // every reactive tick is cheap for the sizes we expect (hundreds of nodes).
  $effect(() => {
    // Touch the relevant fields so Svelte tracks them.
    void doc.nodes.length;
    void doc.edges.length;
    for (const n of doc.nodes) {
      void n.x; void n.y; void n.width; void n.height;
      if (n.type === "text") void (n as CanvasTextNode).text;
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
    if (editingId) return;
    // Middle mouse OR space+drag OR click on empty area with no card hit.
    const isPan = e.button === 1 || (e.button === 0 && spaceHeld);
    if (!isPan) return;
    e.preventDefault();
    selectedId = null;
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
    }
  }

  function onViewportPointerUp(e: PointerEvent) {
    if (!pointerMode) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    pointerMode = null;
  }

  function onViewportDblClick(e: MouseEvent) {
    // Empty-area double-click creates a new text node centered at the cursor.
    if (editingId) return;
    const target = e.target as HTMLElement;
    if (target.closest(".vc-canvas-node")) return;
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
    selectedId = node.id;
    editingId = node.id;
  }

  function onNodePointerDown(e: PointerEvent, node: CanvasNode) {
    if (editingId === node.id) return;
    if (e.button !== 0 || spaceHeld) return;
    e.stopPropagation();
    selectedId = node.id;
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
    editingId = node.id;
    selectedId = node.id;
  }

  function onResizePointerDown(e: PointerEvent, node: CanvasNode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    selectedId = node.id;
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

  function onTextEdit(e: Event, node: CanvasTextNode) {
    node.text = (e.target as HTMLTextAreaElement).value;
  }

  function onTextBlur() {
    editingId = null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (editingId) {
      // Let Escape exit text editing without deleting the card.
      if (e.key === "Escape") {
        e.preventDefault();
        editingId = null;
      }
      return;
    }
    if (e.key === " " && !e.repeat) {
      spaceHeld = true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      e.preventDefault();
      const id = selectedId;
      doc.nodes = doc.nodes.filter((n) => n.id !== id);
      doc.edges = doc.edges.filter((ed) => ed.fromNode !== id && ed.toNode !== id);
      selectedId = null;
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.key === " ") spaceHeld = false;
  }
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<div
  class="vc-canvas-viewport"
  class:vc-canvas-panning={spaceHeld}
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
      {#each doc.nodes as node (node.id)}
        {#if node.type === "text"}
          <div
            class="vc-canvas-node vc-canvas-node-text"
            class:vc-canvas-node-selected={selectedId === node.id}
            class:vc-canvas-node-editing={editingId === node.id}
            style:left={`${node.x}px`}
            style:top={`${node.y}px`}
            style:width={`${node.width}px`}
            style:height={`${node.height}px`}
            data-node-id={node.id}
            onpointerdown={(e) => onNodePointerDown(e, node)}
            ondblclick={(e) => onNodeDblClick(e, node)}
            role="button"
            tabindex="0"
          >
            {#if editingId === node.id}
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
          </div>
        {:else}
          <!-- Phase 1 only renders text. Other node types round-trip
               through the parser/serializer but show a placeholder so
               editors are not lost when the user saves. -->
          <div
            class="vc-canvas-node vc-canvas-node-placeholder"
            class:vc-canvas-node-selected={selectedId === node.id}
            style:left={`${node.x}px`}
            style:top={`${node.y}px`}
            style:width={`${node.width}px`}
            style:height={`${node.height}px`}
            data-node-id={node.id}
            onpointerdown={(e) => onNodePointerDown(e, node)}
            role="button"
            tabindex="0"
          >
            <div class="vc-canvas-node-content">
              <em>{node.type}</em>
            </div>
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

  .vc-canvas-world {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
  }

  .vc-canvas-node {
    position: absolute;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
