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
  //
  // Phase 3: embedded content (#126). File nodes render as an image, a
  // markdown-preview card, or a filename card — clicking the card's "Open"
  // control routes the file through openFileAsTab so the user can jump
  // into the main editor. Link nodes render a click-to-open card whose
  // target opens in the OS browser. Group nodes render as a labelled
  // translucent container that sits visually behind other nodes.

  import { onMount, onDestroy, tick, untrack } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { get } from "svelte/store";
  import { readFile, writeFile } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore } from "../../store/tabStore";
  import { openFileAsTab } from "../../lib/openFileAsTab";
  import { resolveTarget } from "../Editor/wikiLink";
  import { renderMarkdownToHtml } from "../Editor/reading/markdownRenderer";
  import CanvasRenderer from "./CanvasRenderer.svelte";
  import {
    parseCanvas,
    serializeCanvas,
    emptyCanvas,
  } from "../../lib/canvas/parse";
  import type {
    CanvasDoc,
    CanvasEdge,
    CanvasFileNode,
    CanvasGroupNode,
    CanvasLinkNode,
    CanvasNode,
    CanvasSide,
    CanvasTextNode,
  } from "../../lib/canvas/types";
  import {
    DEFAULT_NODE_WIDTH,
    DEFAULT_NODE_HEIGHT,
  } from "../../lib/canvas/types";
  import { anchorPoint } from "../../lib/canvas/geometry";
  import {
    canvasFilePreview,
    isImageFile,
    isMarkdownFile,
    resolveVaultAbs,
    toVaultRel,
  } from "../../lib/canvas/embed";
  import {
    type PointerMode,
    type DraftEdge,
    LONGPRESS_HOLD_MS,
    beginPan,
    beginMove,
    beginResize,
    beginEdge,
    beginPendingLongpress,
    pendingLongpressExceeded,
    longpressFire,
    longpressFallback,
    panPosition,
    movePosition,
    resizeSize,
    updateDraftOnMove,
    resolvePointerUp,
  } from "../../lib/canvas/pointerMode";

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

  // Draft edge: populated while the user drags from a handle. The state
  // machine in `pointerMode.ts` owns the update + commit rules.
  let draft = $state<DraftEdge | null>(null);

  let viewportEl: HTMLDivElement | null = null;
  let editingTextareaEl = $state<HTMLTextAreaElement | null>(null);
  let editingEdgeLabelEl = $state<HTMLInputElement | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWrittenJson = "";
  let suppressSave = true;
  let spaceHeld = $state(false);

  // Rendered-markdown previews for file-nodes, keyed by vault-relative
  // `file` field so multiple file-nodes at the same note share one read.
  // Missing / failed reads become "" so the renderer falls back to a
  // generic file card. `$state` keeps the template reactive to async loads.
  let mdPreviews = $state<Record<string, string>>({});

  let pointerMode = $state<PointerMode | null>(null);
  let longpressTimer: ReturnType<typeof setTimeout> | null = null;
  // Pointer-capture target for the current gesture. Long-press starts on
  // either the viewport (empty-canvas press) or on a node element; pointer-up
  // must release capture from the same element to keep subsequent events in
  // the native handler chain.
  let longpressCaptureEl: HTMLElement | null = null;

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
      // #154: surface the save via tabStore so embedPlugin's diff-on-snapshot
      // subscriber invalidates cached canvas embeds — write_ignore hides our
      // own writes from the watcher, so this is the only signal other views
      // have that the .canvas just changed.
      tabStore.setLastSavedContent(tabId, serialized);
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
    cancelLongpressTimer();
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

  // Lazily load markdown body for every file-node that points at an .md note.
  // We resolve the file relative to the current vault root; when the vault
  // path is missing (e.g., a stray canvas opened without a vault) we fall
  // back to a generic card by leaving the preview unset.
  $effect(() => {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    for (const n of doc.nodes) {
      if (n.type !== "file") continue;
      const file = (n as CanvasFileNode).file;
      if (!file || !isMarkdownFile(file)) continue;
      if (file in untrack(() => mdPreviews)) continue;
      // Reserve the slot synchronously so we don't re-queue the same file.
      mdPreviews = { ...mdPreviews, [file]: "" };
      const absPath = resolveVaultAbs(vaultPath, file);
      void readFile(absPath).then(
        (body) => {
          mdPreviews = {
            ...mdPreviews,
            [file]: renderMarkdownToHtml(canvasFilePreview(body)),
          };
        },
        () => {
          /* preview failure stays as "" — renderer shows a generic card */
        },
      );
    }
  });

  async function onOpenFileNode(node: CanvasFileNode) {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    try {
      await openFileAsTab(resolveVaultAbs(vaultPath, node.file));
    } catch (e) {
      const ve = isVaultError(e)
        ? e
        : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function onOpenLinkNode(node: CanvasLinkNode) {
    try {
      window.open(node.url, "_blank", "noopener,noreferrer");
    } catch {
      /* popup blocked or unsupported — silently swallow */
    }
  }

  async function onOpenWikiTarget(target: string) {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    const resolved = resolveTarget(target);
    if (!resolved) return;
    try {
      await openFileAsTab(resolveVaultAbs(vaultPath, resolved));
    } catch (e) {
      const ve = isVaultError(e)
        ? e
        : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

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
    if (isPan) {
      e.preventDefault();
      selectedNodeId = null;
      selectedEdgeId = null;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      pointerMode = beginPan(e, { x: camX, y: camY });
      return;
    }
    // Left-click on empty viewport → start long-press-to-pan timer (#144).
    // No movement yet — the timer fires after LONGPRESS_HOLD_MS if the
    // pointer hasn't moved past the threshold.
    if (e.button !== 0) return;
    selectedNodeId = null;
    selectedEdgeId = null;
    startLongpress(e, { kind: "none" });
  }

  function startLongpress(
    e: PointerEvent,
    fallback: { kind: "none" } | { kind: "move"; nodeId: string; nodeStartX: number; nodeStartY: number },
  ) {
    pointerMode = beginPendingLongpress(e, fallback);
    const el = e.currentTarget as HTMLElement;
    longpressCaptureEl = el;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture throws for synthetic-test pointer IDs */
    }
    if (longpressTimer) clearTimeout(longpressTimer);
    longpressTimer = setTimeout(() => {
      longpressTimer = null;
      if (pointerMode?.kind !== "pending-longpress") return;
      pointerMode = longpressFire(pointerMode, { x: camX, y: camY });
    }, LONGPRESS_HOLD_MS);
  }

  function cancelLongpressTimer() {
    if (longpressTimer) {
      clearTimeout(longpressTimer);
      longpressTimer = null;
    }
  }

  function onViewportPointerMove(e: PointerEvent) {
    let mode = pointerMode;
    if (!mode) return;
    if (mode.kind === "pending-longpress") {
      if (!pendingLongpressExceeded(mode, e)) return;
      // User moved past the threshold before the timer fired — cancel the
      // pending pan and fall through to the original gesture. If no
      // fallback exists (viewport-only press), clear the mode so the event
      // stops driving anything until pointer-up.
      cancelLongpressTimer();
      const next = longpressFallback(mode);
      pointerMode = next;
      if (!next) return;
      mode = next;
    }
    if (mode.kind === "pan") {
      const p = panPosition(mode, e);
      camX = p.camX;
      camY = p.camY;
    } else if (mode.kind === "move") {
      const p = movePosition(mode, e, zoom);
      const node = doc.nodes.find((n) => n.id === mode.nodeId);
      if (node) {
        node.x = p.x;
        node.y = p.y;
      }
    } else if (mode.kind === "resize") {
      const s = resizeSize(mode, e, zoom);
      const node = doc.nodes.find((n) => n.id === mode.nodeId);
      if (node) {
        node.width = s.width;
        node.height = s.height;
      }
    } else if (mode.kind === "edge" && draft) {
      draft = updateDraftOnMove(
        draft,
        clientToWorld(e.clientX, e.clientY),
        handleAtPoint(e.clientX, e.clientY),
      );
    }
  }

  function onViewportPointerUp(e: PointerEvent) {
    if (!pointerMode) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch { /* releasePointerCapture may throw in the synthetic test env */ }
    if (longpressCaptureEl && longpressCaptureEl !== e.currentTarget) {
      try {
        longpressCaptureEl.releasePointerCapture?.(e.pointerId);
      } catch { /* synthetic-test pointer ID */ }
    }
    cancelLongpressTimer();
    longpressCaptureEl = null;
    const action = resolvePointerUp(pointerMode, draft);
    if (action.kind === "commit-edge") {
      commitDraftEdge(action.fromId, action.fromSide, action.toId, action.toSide);
    }
    if (pointerMode.kind === "edge") draft = null;
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
    // Enter pending-longpress — if the user keeps the pointer still for
    // LONGPRESS_HOLD_MS we flip to pan; if they move past the threshold
    // first, we fall through to beginMove (the original gesture).
    startLongpress(e, {
      kind: "move",
      nodeId: node.id,
      nodeStartX: node.x,
      nodeStartY: node.y,
    });
  }

  function onNodeDblClick(e: MouseEvent, node: CanvasNode) {
    e.stopPropagation();
    if (node.type !== "text") return;
    editingNodeId = node.id;
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  // #130: keyboard activation for role="button" canvas cards. Enter / Space
  // run `action` (the equivalent of a click / dblclick) and we prevent Space
  // from scrolling the page. Called per-node so the caller picks the right
  // semantic action (start-edit for text/edge, open for file/link).
  function onCardKey(e: KeyboardEvent, action: () => void) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      action();
    }
  }

  function startEditText(node: CanvasTextNode) {
    editingNodeId = node.id;
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  function startEditEdgeLabel(edge: CanvasEdge) {
    editingEdgeId = edge.id;
    selectedEdgeId = edge.id;
    selectedNodeId = null;
  }

  function selectNode(node: CanvasNode) {
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  function onResizePointerDown(e: PointerEvent, node: CanvasNode) {
    e.stopPropagation();
    if (e.button !== 0) return;
    selectedNodeId = node.id;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerMode = beginResize(node, e);
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
    pointerMode = beginEdge(node.id, side);
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

  // Drag-and-drop from the sidebar tree: a file drop turns into a
  // canvas file-node pinned at the drop point. Folder drags carry
  // `text/vaultcore-folder` and are ignored — canvas file-nodes target
  // a single file, not a directory.
  function onViewportDragOver(e: DragEvent) {
    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes("text/vaultcore-file")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onViewportDrop(e: DragEvent) {
    if (!e.dataTransfer) return;
    const absPath = e.dataTransfer.getData("text/vaultcore-file");
    if (!absPath) return;
    e.preventDefault();
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    const rel = toVaultRel(vaultPath, absPath);
    if (!rel) {
      toastStore.push({
        variant: "error",
        message: "Datei liegt außerhalb des aktuellen Vaults",
      });
      return;
    }
    const { x, y } = clientToWorld(e.clientX, e.clientY);
    const node: CanvasFileNode = {
      id: crypto.randomUUID(),
      type: "file",
      x: x - DEFAULT_NODE_WIDTH / 2,
      y: y - DEFAULT_NODE_HEIGHT / 2,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      file: rel,
    };
    doc.nodes = [...doc.nodes, node];
    selectedNodeId = node.id;
    selectedEdgeId = null;
    editingNodeId = null;
  }

  // True while a long-press-to-pan pan is actively driving the camera. Used
  // to force the `grabbing` cursor globally on the canvas.
  let isPanActive = $derived(pointerMode?.kind === "pan");
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<div
  class="vc-canvas-viewport"
  class:vc-canvas-panning={spaceHeld}
  class:vc-canvas-pan-active={isPanActive}
  class:vc-canvas-drafting={!!draft}
  bind:this={viewportEl}
  role="application"
  aria-label="Canvas"
  data-tab-id={tabId}
  data-pointer-mode={pointerMode?.kind ?? "idle"}
  onpointerdown={onViewportPointerDown}
  onpointermove={onViewportPointerMove}
  onpointerup={onViewportPointerUp}
  onpointercancel={onViewportPointerUp}
  ondblclick={onViewportDblClick}
  ondragover={onViewportDragOver}
  ondrop={onViewportDrop}
  onwheel={onWheel}
>
  {#if !loaded}
    <div class="vc-canvas-loading">Loading canvas…</div>
  {:else if loadError}
    <div class="vc-canvas-error">{loadError}</div>
  {:else}
    <CanvasRenderer
      {doc}
      {camX}
      {camY}
      {zoom}
      vaultPath={$vaultStore.currentPath}
      {mdPreviews}
      interactive={true}
      {selectedNodeId}
      {selectedEdgeId}
      {hoveredNodeId}
      {editingNodeId}
      {editingEdgeId}
      {draft}
      bind:editingTextareaEl
      bind:editingEdgeLabelEl
      onNodePointerDown={onNodePointerDown}
      onNodeDblClick={onNodeDblClick}
      onNodeHoverEnter={(n) => (hoveredNodeId = n.id)}
      onNodeHoverLeave={(n) => { if (hoveredNodeId === n.id) hoveredNodeId = null; }}
      onResizePointerDown={onResizePointerDown}
      onHandlePointerDown={onHandlePointerDown}
      onCardKey={onCardKey}
      onStartEditText={startEditText}
      onTextEdit={onTextEdit}
      onTextBlur={onTextBlur}
      onOpenFileNode={(n) => { void onOpenFileNode(n); }}
      onOpenLinkNode={onOpenLinkNode}
      onOpenWikiTarget={(t) => { void onOpenWikiTarget(t); }}
      onSelectNode={selectNode}
      onEdgeHitPointerDown={onEdgeHitPointerDown}
      onEdgeDblClick={onEdgeDblClick}
      onEdgeLabelInput={onEdgeLabelInput}
      onEdgeLabelBlur={onEdgeLabelBlur}
      onStartEditEdgeLabel={startEditEdgeLabel}
      onStopEditingEdge={() => (editingEdgeId = null)}
    />
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

  .vc-canvas-pan-active,
  .vc-canvas-pan-active * {
    cursor: grabbing !important;
  }

  .vc-canvas-drafting {
    cursor: crosshair;
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
