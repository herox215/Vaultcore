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
  import { listenFileChange } from "../../ipc/events";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore } from "../../store/tabStore";
  import { treeRevealStore } from "../../store/treeRevealStore";
  import { openFileAsTab } from "../../lib/openFileAsTab";
  import { resolveTarget } from "../Editor/wikiLink";
  import { renderMarkdownToHtml } from "../Editor/reading/markdownRenderer";
  import CanvasRenderer from "./CanvasRenderer.svelte";
  import CanvasShapePicker from "./CanvasShapePicker.svelte";
  import ContextMenu from "../common/ContextMenu.svelte";
  import ColorPicker from "../common/ColorPicker.svelte";
  import UrlInputModal from "../common/UrlInputModal.svelte";
  import OmniSearch from "../Search/OmniSearch.svelte";
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
    CanvasShape,
    CanvasSide,
    CanvasTextNode,
  } from "../../lib/canvas/types";
  import {
    DEFAULT_NODE_WIDTH,
    DEFAULT_NODE_HEIGHT,
    DEFAULT_CANVAS_SHAPE,
    readShape,
  } from "../../lib/canvas/types";
  import { anchorPoint } from "../../lib/canvas/geometry";
  import { computeCanvasTextHtml } from "../../lib/canvas/textMarkdown";
  import { titleFromPath } from "../../lib/templateScope";
  import {
    canvasFilePreview,
    isImageFile,
    isMarkdownFile,
    resolveVaultAbs,
    toVaultRel,
  } from "../../lib/canvas/embed";
  import { snapshotCanvas } from "../../lib/canvas/canvasTabMorph";
  import {
    registerCanvasSnapshot,
    unregisterCanvasSnapshot,
  } from "../../lib/canvas/canvasMorphRegistry";
  import {
    type PointerMode,
    type DraftEdge,
    type MoveMember,
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
    memberPositions,
    resizeSize,
    updateDraftOnMove,
    resolvePointerUp,
  } from "../../lib/canvas/pointerMode";
  import { nodesInsideGroup } from "../../lib/canvas/group";

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

  // #364: pre-rendered Markdown HTML for every text node, keyed by
  // node.id. Recomputed whenever `doc.nodes` or `editingNodeId`
  // change — the currently-edited node is intentionally skipped so
  // we don't burn a render per keystroke (the textarea owns the
  // display in that branch). `renderMarkdownToHtml` is sync and
  // cheap for small card-sized text, so a blanket recompute is
  // fine for MVP. If this ever shows up in a flame graph, swap in
  // a per-node memo keyed on `node.text`.
  let mdTextNodes = $derived(
    computeCanvasTextHtml(doc, editingNodeId, titleFromPath(abs)),
  );

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
    // #383: expose a snapshot fn so EditorPane's tab-morph overlay can
    // capture this canvas during canvas↔text and canvas↔canvas switches.
    // Closure reads `viewportEl`, `doc`, `camX/Y`, `zoom` at snapshot
    // time — they're plain `let` (DOM ref) and `$state` (camera + doc),
    // both of which the closure observes at lookup, not at registration.
    registerCanvasSnapshot(tabId, () =>
      viewportEl ? snapshotCanvas(viewportEl, doc, camX, camY, zoom) : null,
    );
  });

  onDestroy(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void persist();
    }
    cancelLongpressTimer();
    unregisterCanvasSnapshot(tabId);
    // #165: tear down preview-invalidation subscriptions so multi-tab
    // open/close cycles don't leak listeners.
    unsubTab();
    destroyed = true;
    watcherUnlisten?.();
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
      if (n.type === "text") {
        void (n as CanvasTextNode).text;
        // #362: shape mutations (setNodeShape) must schedule a save.
        void (n as CanvasTextNode).shape;
      }
      if (n.type === "link") void (n as CanvasLinkNode).url;
      if (n.type === "group") {
        void (n as CanvasGroupNode).label;
        void (n as CanvasGroupNode).background;
      }
    }
    for (const e of doc.edges) {
      void e.fromNode; void e.toNode; void e.fromSide; void e.toSide;
      void e.color; void e.label;
    }
    scheduleSave();
  });

  // #165: per-file fetch-generation map. Incremented every time we kick a
  // re-fetch for a given path so a stale in-flight read whose invalidation
  // arrived mid-fetch cannot overwrite the fresh body. Pure module state —
  // the view never renders it, so it's a plain `let`, not `$state`.
  let mdPreviewGen: Map<string, number> = new Map();

  function loadPreviewFor(vaultPath: string, file: string): void {
    if (!isMarkdownFile(file)) return;
    const gen = (mdPreviewGen.get(file) ?? 0) + 1;
    mdPreviewGen.set(file, gen);
    // Reserve the slot synchronously so the effect's `file in mdPreviews`
    // guard doesn't re-queue the same fetch while it's in flight.
    mdPreviews = { ...mdPreviews, [file]: "" };
    const absPath = resolveVaultAbs(vaultPath, file);
    void readFile(absPath).then(
      (body) => {
        // Drop the result if a newer fetch for the same file has started —
        // otherwise a tabStore eviction followed by a re-fetch could have
        // its fresh body clobbered by this older in-flight read resolving
        // after it (#165).
        if (mdPreviewGen.get(file) !== gen) return;
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
      loadPreviewFor(vaultPath, file);
    }
  });

  // #165: invalidate embedded-note previews when the source note is saved
  // from another tab or modified externally. Mirror the pattern
  // embedPlugin.ts uses for the inverse direction (canvas-inside-note).
  //
  // Two sources of change, independent because the watcher's write_ignore
  // suppresses our own saves — we can't rely on `listenFileChange` alone:
  //   (a) tabStore.setLastSavedContent — fires when any tab auto-saves.
  //   (b) listenFileChange — fires for external edits (other editors, shell,
  //       git checkout).
  //
  // Rename payloads (`new_path`) are a non-goal for #165: canvas nodes pin
  // `file` by its original vault-relative path; after a rename that path no
  // longer exists so re-fetching would just fail silently. Out of scope.
  const lastSavedByTabId: Map<string, string> = new Map();
  const unsubTab = tabStore.subscribe((state) => {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    const fileNodes = untrack(() =>
      doc.nodes
        .filter((n): n is CanvasFileNode => n.type === "file")
        .map((n) => n.file)
        .filter((f) => !!f && isMarkdownFile(f)),
    );
    for (const tab of state.tabs) {
      const prev = lastSavedByTabId.get(tab.id);
      if (prev === tab.lastSavedContent) continue;
      lastSavedByTabId.set(tab.id, tab.lastSavedContent);
      if (prev === undefined) continue; // first sighting isn't a change
      const rel = toVaultRel(vaultPath, tab.filePath);
      if (!rel) continue;
      const normalized = rel.replace(/\\/g, "/");
      if (fileNodes.some((f) => f.replace(/\\/g, "/") === normalized)) {
        loadPreviewFor(vaultPath, normalized);
      }
    }
    // Prune snapshots for tabs that have closed so the map doesn't leak.
    const liveIds = new Set(state.tabs.map((t) => t.id));
    for (const id of Array.from(lastSavedByTabId.keys())) {
      if (!liveIds.has(id)) lastSavedByTabId.delete(id);
    }
  });

  // The async listen/unlisten contract means a quick mount/unmount could
  // leak the subscription if we just stored the resolved unlisten fn; the
  // `destroyed` flag guards against that race.
  let watcherUnlisten: (() => void) | null = null;
  let destroyed = false;
  void listenFileChange((payload) => {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    const paths = payload.new_path ? [payload.path, payload.new_path] : [payload.path];
    for (const p of paths) {
      const rel = toVaultRel(vaultPath, p);
      if (!rel) continue;
      const normalized = rel.replace(/\\/g, "/");
      const fileNodes = untrack(() =>
        doc.nodes
          .filter((n): n is CanvasFileNode => n.type === "file")
          .map((n) => n.file)
          .filter((f) => !!f && isMarkdownFile(f)),
      );
      if (fileNodes.some((f) => f.replace(/\\/g, "/") === normalized)) {
        loadPreviewFor(vaultPath, normalized);
      }
    }
  }).then(
    (fn) => {
      if (destroyed) fn();
      else watcherUnlisten = fn;
    },
    () => {
      /* Tauri not initialized (vitest) — swallow so the module still loads. */
    },
  );

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
    fallback:
      | { kind: "none" }
      | {
          kind: "move";
          nodeId: string;
          nodeStartX: number;
          nodeStartY: number;
          members: MoveMember[];
        },
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
      // Group drags (#168): translate each snapshotted member by the same
      // zoom-scaled delta so the contained nodes move with the group.
      if (mode.members.length > 0) {
        const positions = memberPositions(mode, e, zoom);
        for (const mp of positions) {
          const m = doc.nodes.find((n) => n.id === mp.nodeId);
          if (m) {
            m.x = mp.x;
            m.y = mp.y;
          }
        }
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
    // For group nodes, snapshot every node fully inside the group at this
    // instant so a subsequent drag translates them together (#168).
    // Containment is evaluated here (pointer-down) — not on every mousemove —
    // so the set is stable even if the doc is reordered mid-drag.
    const members: MoveMember[] =
      node.type === "group"
        ? nodesInsideGroup(doc, node).map((m) => ({
            nodeId: m.id,
            startX: m.x,
            startY: m.y,
          }))
        : [];
    // Enter pending-longpress — if the user keeps the pointer still for
    // LONGPRESS_HOLD_MS we flip to pan; if they move past the threshold
    // first, we fall through to beginMove (the original gesture).
    startLongpress(e, {
      kind: "move",
      nodeId: node.id,
      nodeStartX: node.x,
      nodeStartY: node.y,
      members,
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
    // File-nodes render a header + (for markdown) a preview body, so the
    // 60 px default used for text cards is too small to show anything
    // useful. `addFileNodeAt` uses a 400×400 card that matches Obsidian's
    // drag-default size and gives the markdown preview room to render.
    const { x, y } = clientToWorld(e.clientX, e.clientY);
    addFileNodeAt(x, y, rel);
  }

  // True while a long-press-to-pan pan is actively driving the camera. Used
  // to force the `grabbing` cursor globally on the canvas.
  let isPanActive = $derived(pointerMode?.kind === "pan");

  // ─── Context menus (#164) ─────────────────────────────────────────────
  // Discriminated target — picks the menu entries the user sees and the
  // action handlers wired up below.
  type ContextTarget =
    | { kind: "empty"; worldX: number; worldY: number }
    | { kind: "node"; nodeId: string }
    | { kind: "edge"; edgeId: string };

  let contextMenu = $state<{ target: ContextTarget; x: number; y: number } | null>(null);

  // #362: which shape-picker submenu is inline-expanded inside the current
  // context menu. `null` = no picker open (the menu behaves as before);
  // `"add-text"` = empty-space "Add text node ▾" is expanded; `"change-shape"`
  // = text-node "Change shape…" is expanded. Resets whenever the menu closes.
  let shapeSubmenuOpen = $state<"add-text" | "change-shape" | null>(null);
  // Trigger row refs so we can refocus the parent item when the picker
  // collapses via ArrowLeft — without this the keyboard focus falls back
  // to document.body and the menu arrow-nav chain breaks.
  let addTextTriggerEl = $state<HTMLButtonElement | null>(null);
  let changeShapeTriggerEl = $state<HTMLButtonElement | null>(null);

  // Snapshot of the node / edge under the menu so the template can branch on
  // type without re-scanning the doc on every render.
  const contextNode = $derived.by((): CanvasNode | null => {
    if (contextMenu?.target.kind !== "node") return null;
    const id = contextMenu.target.nodeId;
    return doc.nodes.find((n) => n.id === id) ?? null;
  });

  const contextEdge = $derived.by((): CanvasEdge | null => {
    if (contextMenu?.target.kind !== "edge") return null;
    const id = contextMenu.target.edgeId;
    return doc.edges.find((e) => e.id === id) ?? null;
  });

  function closeContextMenu() {
    contextMenu = null;
    // Always collapse any expanded inline picker so the next menu opens
    // clean. Ref cleanup happens automatically via the bind: on unmount.
    shapeSubmenuOpen = null;
  }

  function cancelGestureForContextMenu() {
    // Right-click cancels any in-flight longpress / pending pan so the menu
    // doesn't surface on top of a primed pan gesture.
    cancelLongpressTimer();
    longpressCaptureEl = null;
    pointerMode = null;
    // Commit any in-progress inline edit so the new context menu's entries
    // operate on saved state, not on a half-typed URL / label.
    editingNodeId = null;
    editingEdgeId = null;
    // #362: drop any inline-picker state from a previous menu so a fresh
    // right-click never surfaces a stale auto-expanded picker.
    shapeSubmenuOpen = null;
  }

  function onViewportContextMenu(e: MouseEvent) {
    // Bubbles from node/edge handlers — stopPropagation there prevents this.
    e.preventDefault();
    cancelGestureForContextMenu();
    selectedNodeId = null;
    selectedEdgeId = null;
    const { x, y } = clientToWorld(e.clientX, e.clientY);
    contextMenu = {
      target: { kind: "empty", worldX: x, worldY: y },
      x: e.clientX,
      y: e.clientY,
    };
  }

  function onNodeContextMenu(e: MouseEvent, node: CanvasNode) {
    e.preventDefault();
    e.stopPropagation();
    cancelGestureForContextMenu();
    selectedNodeId = node.id;
    selectedEdgeId = null;
    contextMenu = {
      target: { kind: "node", nodeId: node.id },
      x: e.clientX,
      y: e.clientY,
    };
  }

  function onEdgeContextMenu(e: MouseEvent, edge: CanvasEdge) {
    e.preventDefault();
    e.stopPropagation();
    cancelGestureForContextMenu();
    selectedEdgeId = edge.id;
    selectedNodeId = null;
    contextMenu = {
      target: { kind: "edge", edgeId: edge.id },
      x: e.clientX,
      y: e.clientY,
    };
  }

  // ─── Menu actions ──────────────────────────────────────────────────────

  function addTextNodeAt(worldX: number, worldY: number, shape?: CanvasShape) {
    const node: CanvasTextNode = {
      id: crypto.randomUUID(),
      type: "text",
      x: worldX - DEFAULT_NODE_WIDTH / 2,
      y: worldY - DEFAULT_NODE_HEIGHT / 2,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      text: "",
      // #362: record a non-default shape so it serialises. Default shape
      // is never written — keeps existing canvases byte-identical.
      ...(shape && shape !== DEFAULT_CANVAS_SHAPE ? { shape } : {}),
    };
    doc.nodes = [...doc.nodes, node];
    selectedNodeId = node.id;
    selectedEdgeId = null;
    editingNodeId = node.id;
  }

  // #362: change a text node's shape. Default shape is stored as
  // `undefined` so on-disk JSON omits the field and matches the pre-#362
  // format — minimising diff noise in vaults that never use other shapes.
  function setNodeShape(nodeId: string, shape: CanvasShape) {
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "text") return;
    // Reset-to-default stores `undefined` (serializer drops the field)
    // rather than `delete`ing the key. Assignment reliably trips the
    // $state proxy's set trap; `delete` goes through deleteProperty
    // whose reactivity contract is less explicit across Svelte 5 versions.
    (node as CanvasTextNode).shape =
      shape === DEFAULT_CANVAS_SHAPE ? undefined : shape;
  }

  function addGroupAt(worldX: number, worldY: number) {
    const GROUP_W = 400;
    const GROUP_H = 300;
    const node: CanvasGroupNode = {
      id: crypto.randomUUID(),
      type: "group",
      x: worldX - GROUP_W / 2,
      y: worldY - GROUP_H / 2,
      width: GROUP_W,
      height: GROUP_H,
    };
    doc.nodes = [...doc.nodes, node];
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  // File + link node creation helpers — extracted so the context-menu
  // entries (#166) and the sidebar drag-drop path share one sizing.
  const FILE_NODE_DEFAULT_W = 400;
  const FILE_NODE_DEFAULT_H = 400;
  const LINK_NODE_DEFAULT_W = 400;
  const LINK_NODE_DEFAULT_H = 100;

  function addFileNodeAt(worldX: number, worldY: number, rel: string) {
    const node: CanvasFileNode = {
      id: crypto.randomUUID(),
      type: "file",
      x: worldX - FILE_NODE_DEFAULT_W / 2,
      y: worldY - FILE_NODE_DEFAULT_H / 2,
      width: FILE_NODE_DEFAULT_W,
      height: FILE_NODE_DEFAULT_H,
      file: rel,
    };
    doc.nodes = [...doc.nodes, node];
    selectedNodeId = node.id;
    selectedEdgeId = null;
    editingNodeId = null;
  }

  function addLinkNodeAt(worldX: number, worldY: number, url: string) {
    const node: CanvasLinkNode = {
      id: crypto.randomUUID(),
      type: "link",
      x: worldX - LINK_NODE_DEFAULT_W / 2,
      y: worldY - LINK_NODE_DEFAULT_H / 2,
      width: LINK_NODE_DEFAULT_W,
      height: LINK_NODE_DEFAULT_H,
      url,
    };
    doc.nodes = [...doc.nodes, node];
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  function duplicateNode(nodeId: string) {
    const src = doc.nodes.find((n) => n.id === nodeId);
    if (!src) return;
    const clone: CanvasNode = {
      ...src,
      id: crypto.randomUUID(),
      x: src.x + 24,
      y: src.y + 24,
    };
    doc.nodes = [...doc.nodes, clone];
    selectedNodeId = clone.id;
    selectedEdgeId = null;
  }

  function copyNodeToClipboard(nodeId: string) {
    const src = doc.nodes.find((n) => n.id === nodeId);
    if (!src) return;
    try {
      void navigator.clipboard.writeText(JSON.stringify(src));
    } catch {
      /* clipboard API blocked — silently swallow */
    }
  }

  function copyTextToClipboard(text: string) {
    try {
      void navigator.clipboard.writeText(text);
    } catch {
      /* clipboard API blocked */
    }
  }

  function bringNodeToFront(nodeId: string) {
    const src = doc.nodes.find((n) => n.id === nodeId);
    if (!src) return;
    // Groups render behind other nodes (CanvasRenderer sorts group-first);
    // reordering across that band has no visual effect, so we keep the swap
    // within the same band to stay intuitive.
    const rest = doc.nodes.filter((n) => n.id !== nodeId);
    doc.nodes = [...rest, src];
  }

  function sendNodeToBack(nodeId: string) {
    const src = doc.nodes.find((n) => n.id === nodeId);
    if (!src) return;
    const rest = doc.nodes.filter((n) => n.id !== nodeId);
    doc.nodes = [src, ...rest];
  }

  function deleteNode(nodeId: string) {
    doc.nodes = doc.nodes.filter((n) => n.id !== nodeId);
    doc.edges = doc.edges.filter(
      (ed) => ed.fromNode !== nodeId && ed.toNode !== nodeId,
    );
    if (selectedNodeId === nodeId) selectedNodeId = null;
  }

  function deleteEdge(edgeId: string) {
    doc.edges = doc.edges.filter((ed) => ed.id !== edgeId);
    if (selectedEdgeId === edgeId) selectedEdgeId = null;
  }

  function flipEdge(edgeId: string) {
    const idx = doc.edges.findIndex((e) => e.id === edgeId);
    if (idx < 0) return;
    const src = doc.edges[idx];
    if (!src) return;
    const swapped: CanvasEdge = { ...src, fromNode: src.toNode, toNode: src.fromNode };
    if (src.toSide !== undefined) swapped.fromSide = src.toSide;
    else delete swapped.fromSide;
    if (src.fromSide !== undefined) swapped.toSide = src.fromSide;
    else delete swapped.toSide;
    if (src.toEnd !== undefined) swapped.fromEnd = src.toEnd;
    else delete swapped.fromEnd;
    if (src.fromEnd !== undefined) swapped.toEnd = src.fromEnd;
    else delete swapped.toEnd;
    doc.edges = [
      ...doc.edges.slice(0, idx),
      swapped,
      ...doc.edges.slice(idx + 1),
    ];
  }

  async function revealFileNode(node: CanvasFileNode) {
    treeRevealStore.requestReveal(node.file);
  }

  async function openFileNodeInSplit(node: CanvasFileNode) {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    const absPath = resolveVaultAbs(vaultPath, node.file);
    tabStore.openTab(absPath);
    tabStore.moveToPane("right");
  }

  // ─── #166: deferred context-menu actions ──────────────────────────────
  // Anchor the insertion point for the modal flows (Add file / Add link)
  // so the user gets a node at the right-clicked world coords, not wherever
  // the camera happens to sit when they confirm the modal.
  let pendingFileNodeAt = $state<{ worldX: number; worldY: number } | null>(null);
  let pendingLinkNodeAt = $state<{ worldX: number; worldY: number } | null>(null);

  // Single open picker at a time. `target` discriminates what to mutate
  // on colour change; `value` is passed to the picker for active-swatch
  // highlighting. `null` on change = delete the field so CSS fallbacks
  // re-apply (group) or the default stroke colour kicks in (edge).
  let colorPicker = $state<
    | {
        target: { kind: "group"; id: string } | { kind: "edge"; id: string };
        x: number;
        y: number;
        value: string | null;
      }
    | null
  >(null);

  function openAddFileNode(worldX: number, worldY: number) {
    pendingFileNodeAt = { worldX, worldY };
  }

  function onAddFileNodeConfirm(absPath: string) {
    const anchor = pendingFileNodeAt;
    pendingFileNodeAt = null;
    if (!anchor) return;
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
    addFileNodeAt(anchor.worldX, anchor.worldY, rel);
  }

  function openAddLinkNode(worldX: number, worldY: number) {
    pendingLinkNodeAt = { worldX, worldY };
  }

  function onAddLinkNodeConfirm(url: string) {
    const anchor = pendingLinkNodeAt;
    pendingLinkNodeAt = null;
    if (!anchor) return;
    addLinkNodeAt(anchor.worldX, anchor.worldY, url);
  }

  function startEditLinkUrl(node: CanvasLinkNode) {
    editingNodeId = node.id;
    editingEdgeId = null;
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  function startEditGroupLabel(node: CanvasGroupNode) {
    editingNodeId = node.id;
    editingEdgeId = null;
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  function onLinkUrlInput(e: Event, node: CanvasLinkNode) {
    const target = doc.nodes.find((n) => n.id === node.id);
    if (target && target.type === "link") {
      (target as CanvasLinkNode).url = (e.target as HTMLInputElement).value;
    }
  }

  function onGroupLabelInput(e: Event, node: CanvasGroupNode) {
    const target = doc.nodes.find((n) => n.id === node.id);
    if (!target || target.type !== "group") return;
    const v = (e.target as HTMLInputElement).value;
    if (v === "") {
      delete (target as CanvasGroupNode).label;
    } else {
      (target as CanvasGroupNode).label = v;
    }
  }

  function openColorPickerForGroup(x: number, y: number, node: CanvasGroupNode) {
    colorPicker = {
      target: { kind: "group", id: node.id },
      x,
      y,
      value: node.background ?? null,
    };
  }

  function openColorPickerForEdge(x: number, y: number, edge: CanvasEdge) {
    colorPicker = {
      target: { kind: "edge", id: edge.id },
      x,
      y,
      value: edge.color ?? null,
    };
  }

  function onColorChange(value: string | null) {
    const picker = colorPicker;
    if (!picker) return;
    if (picker.target.kind === "group") {
      const node = doc.nodes.find((n) => n.id === picker.target.id);
      if (node && node.type === "group") {
        if (value === null) delete (node as CanvasGroupNode).background;
        else (node as CanvasGroupNode).background = value;
      }
    } else {
      const edge = doc.edges.find((ed) => ed.id === picker.target.id);
      if (edge) {
        if (value === null) delete edge.color;
        else edge.color = value;
      }
    }
    // Keep the picker open for live drags of the native input; swatch +
    // Clear paths call onClose from inside the picker itself.
    colorPicker = { ...picker, value };
  }

  function closeColorPicker() {
    colorPicker = null;
  }
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
  oncontextmenu={onViewportContextMenu}
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
      {mdTextNodes}
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
      onNodeContextMenu={onNodeContextMenu}
      onEdgeContextMenu={onEdgeContextMenu}
      onLinkUrlInput={onLinkUrlInput}
      onGroupLabelInput={onGroupLabelInput}
      onStopEditingNode={() => (editingNodeId = null)}
    />
  {/if}
</div>

<ContextMenu
  open={contextMenu !== null}
  x={contextMenu?.x ?? 0}
  y={contextMenu?.y ?? 0}
  onClose={closeContextMenu}
>
  {#if contextMenu?.target.kind === "empty"}
    {@const worldX = contextMenu.target.worldX}
    {@const worldY = contextMenu.target.worldY}
    <!-- #362: "Add text node ▾" — click expands the shape picker inline
         inside the same menu panel. Picking a shape creates the node at
         the right-clicked world coords with that shape. Double-click on
         empty canvas remains the fast path that always creates a
         rounded-rectangle without going through the picker. -->
    <button
      bind:this={addTextTriggerEl}
      class="vc-context-item vc-context-item--expandable"
      aria-haspopup="true"
      aria-expanded={shapeSubmenuOpen === "add-text"}
      onclick={() => {
        shapeSubmenuOpen =
          shapeSubmenuOpen === "add-text" ? null : "add-text";
      }}
      onkeydown={(e) => {
        if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          shapeSubmenuOpen = "add-text";
        } else if (e.key === "ArrowLeft" && shapeSubmenuOpen === "add-text") {
          e.preventDefault();
          e.stopPropagation();
          shapeSubmenuOpen = null;
        }
      }}
    >
      <span class="vc-context-item-label">Add text node</span>
    </button>
    {#if shapeSubmenuOpen === "add-text"}
      <div class="vc-context-submenu">
        <CanvasShapePicker
          value={DEFAULT_CANVAS_SHAPE}
          autoFocus={true}
          onPick={(s) => {
            addTextNodeAt(worldX, worldY, s);
            closeContextMenu();
          }}
          onCancel={() => {
            shapeSubmenuOpen = null;
            addTextTriggerEl?.focus();
          }}
        />
      </div>
    {/if}
    <button
      class="vc-context-item"
      onclick={() => { openAddFileNode(worldX, worldY); closeContextMenu(); }}
    >Add file node…</button>
    <button
      class="vc-context-item"
      onclick={() => { openAddLinkNode(worldX, worldY); closeContextMenu(); }}
    >Add link node…</button>
    <button
      class="vc-context-item"
      onclick={() => { addGroupAt(worldX, worldY); closeContextMenu(); }}
    >Add group</button>
  {:else if contextMenu?.target.kind === "node" && contextNode}
    {@const node = contextNode}
    {@const nodeId = node.id}
    {#if node.type === "text"}
      <button
        class="vc-context-item"
        onclick={() => { startEditText(node as CanvasTextNode); closeContextMenu(); }}
      >Edit text</button>
      <button
        class="vc-context-item"
        onclick={() => { duplicateNode(nodeId); closeContextMenu(); }}
      >Duplicate</button>
      <button
        class="vc-context-item"
        onclick={() => { copyTextToClipboard((node as CanvasTextNode).text); closeContextMenu(); }}
      >Copy text</button>
      <!-- #362: "Change shape…" — inline-expand picker with the node's
           current shape pre-selected. Picking a shape rewrites
           node.shape and closes the menu. -->
      <button
        bind:this={changeShapeTriggerEl}
        class="vc-context-item vc-context-item--expandable"
        aria-haspopup="true"
        aria-expanded={shapeSubmenuOpen === "change-shape"}
        onclick={() => {
          shapeSubmenuOpen =
            shapeSubmenuOpen === "change-shape" ? null : "change-shape";
        }}
        onkeydown={(e) => {
          if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            shapeSubmenuOpen = "change-shape";
          } else if (e.key === "ArrowLeft" && shapeSubmenuOpen === "change-shape") {
            e.preventDefault();
            e.stopPropagation();
            shapeSubmenuOpen = null;
          }
        }}
      >
        <span class="vc-context-item-label">Change shape…</span>
      </button>
      {#if shapeSubmenuOpen === "change-shape"}
        <div class="vc-context-submenu">
          <CanvasShapePicker
            value={readShape(node)}
            autoFocus={true}
            onPick={(s) => {
              setNodeShape(nodeId, s);
              closeContextMenu();
            }}
            onCancel={() => {
              shapeSubmenuOpen = null;
              changeShapeTriggerEl?.focus();
            }}
          />
        </div>
      {/if}
      <button
        class="vc-context-item"
        onclick={() => { bringNodeToFront(nodeId); closeContextMenu(); }}
      >Bring to front</button>
      <button
        class="vc-context-item"
        onclick={() => { sendNodeToBack(nodeId); closeContextMenu(); }}
      >Send to back</button>
      <div class="vc-context-separator" role="separator"></div>
      <button
        class="vc-context-item vc-context-item--danger"
        onclick={() => { deleteNode(nodeId); closeContextMenu(); }}
      >Delete</button>
    {:else if node.type === "file"}
      <button
        class="vc-context-item"
        onclick={() => { void onOpenFileNode(node as CanvasFileNode); closeContextMenu(); }}
      >Open in editor</button>
      <button
        class="vc-context-item"
        onclick={() => { void openFileNodeInSplit(node as CanvasFileNode); closeContextMenu(); }}
      >Open in split</button>
      <button
        class="vc-context-item"
        onclick={() => { void revealFileNode(node as CanvasFileNode); closeContextMenu(); }}
      >Reveal in sidebar</button>
      <button
        class="vc-context-item"
        onclick={() => { copyTextToClipboard((node as CanvasFileNode).file); closeContextMenu(); }}
      >Copy vault path</button>
      <button
        class="vc-context-item"
        onclick={() => { duplicateNode(nodeId); closeContextMenu(); }}
      >Duplicate</button>
      <button
        class="vc-context-item"
        onclick={() => { bringNodeToFront(nodeId); closeContextMenu(); }}
      >Bring to front</button>
      <button
        class="vc-context-item"
        onclick={() => { sendNodeToBack(nodeId); closeContextMenu(); }}
      >Send to back</button>
      <div class="vc-context-separator" role="separator"></div>
      <button
        class="vc-context-item vc-context-item--danger"
        onclick={() => { deleteNode(nodeId); closeContextMenu(); }}
      >Delete</button>
    {:else if node.type === "link"}
      <button
        class="vc-context-item"
        onclick={() => { onOpenLinkNode(node as CanvasLinkNode); closeContextMenu(); }}
      >Open link</button>
      <button
        class="vc-context-item"
        onclick={() => { copyTextToClipboard((node as CanvasLinkNode).url); closeContextMenu(); }}
      >Copy URL</button>
      <button
        class="vc-context-item"
        onclick={() => { startEditLinkUrl(node as CanvasLinkNode); closeContextMenu(); }}
      >Edit URL…</button>
      <button
        class="vc-context-item"
        onclick={() => { duplicateNode(nodeId); closeContextMenu(); }}
      >Duplicate</button>
      <button
        class="vc-context-item"
        onclick={() => { bringNodeToFront(nodeId); closeContextMenu(); }}
      >Bring to front</button>
      <button
        class="vc-context-item"
        onclick={() => { sendNodeToBack(nodeId); closeContextMenu(); }}
      >Send to back</button>
      <div class="vc-context-separator" role="separator"></div>
      <button
        class="vc-context-item vc-context-item--danger"
        onclick={() => { deleteNode(nodeId); closeContextMenu(); }}
      >Delete</button>
    {:else if node.type === "group"}
      {@const mx = contextMenu?.x ?? 0}
      {@const my = contextMenu?.y ?? 0}
      <button
        class="vc-context-item"
        onclick={() => { startEditGroupLabel(node as CanvasGroupNode); closeContextMenu(); }}
      >Edit label…</button>
      <button
        class="vc-context-item"
        onclick={() => {
          openColorPickerForGroup(mx, my, node as CanvasGroupNode);
          closeContextMenu();
        }}
      >Change color…</button>
      <button
        class="vc-context-item"
        onclick={() => { duplicateNode(nodeId); closeContextMenu(); }}
      >Duplicate</button>
      <div class="vc-context-separator" role="separator"></div>
      <button
        class="vc-context-item vc-context-item--danger"
        onclick={() => { deleteNode(nodeId); closeContextMenu(); }}
      >Delete</button>
    {/if}
  {:else if contextMenu?.target.kind === "edge" && contextEdge}
    {@const edge = contextEdge}
    {@const edgeId = edge.id}
    {@const mx = contextMenu?.x ?? 0}
    {@const my = contextMenu?.y ?? 0}
    <button
      class="vc-context-item"
      onclick={() => { startEditEdgeLabel(edge); closeContextMenu(); }}
    >Edit label</button>
    <button
      class="vc-context-item"
      onclick={() => { openColorPickerForEdge(mx, my, edge); closeContextMenu(); }}
    >Change color…</button>
    <button
      class="vc-context-item"
      onclick={() => { flipEdge(edgeId); closeContextMenu(); }}
    >Flip direction</button>
    <div class="vc-context-separator" role="separator"></div>
    <button
      class="vc-context-item vc-context-item--danger"
      onclick={() => { deleteEdge(edgeId); closeContextMenu(); }}
    >Delete</button>
  {/if}
</ContextMenu>

<!-- #166: modal + picker surfaces driven by the context menu. Uses the
     #174 OmniSearch modal (filename mode) as the file picker — same contract
     as the legacy QuickSwitcher. -->
<OmniSearch
  open={pendingFileNodeAt !== null}
  initialMode="filename"
  onClose={() => (pendingFileNodeAt = null)}
  onOpenFile={onAddFileNodeConfirm}
/>

<UrlInputModal
  open={pendingLinkNodeAt !== null}
  onConfirm={onAddLinkNodeConfirm}
  onCancel={() => (pendingLinkNodeAt = null)}
/>

<ColorPicker
  open={colorPicker !== null}
  x={colorPicker?.x ?? 0}
  y={colorPicker?.y ?? 0}
  value={colorPicker?.value ?? null}
  onChange={onColorChange}
  onClose={closeColorPicker}
/>


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

  /* #362: expandable context-menu rows and the inline shape-picker
     panel they reveal. Kept in CanvasView (not ContextMenu.svelte) so
     the generic menu stays a presentation-only popover. Scoped under
     `.vc-context-menu` so the classes can't leak to unrelated elements
     that happen to reuse the names. */
  :global(.vc-context-menu .vc-context-item--expandable) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  :global(.vc-context-menu .vc-context-item--expandable .vc-context-item-label) {
    flex: 1;
    min-width: 0;
  }

  /* Chevron rendered via CSS ::after so it doesn't pollute the button's
     textContent — the menu-item tests match on textContent equality and
     the label must read as "Add text node" / "Change shape…", nothing more. */
  :global(.vc-context-menu .vc-context-item--expandable)::after {
    content: "▾";
    flex: 0 0 auto;
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 1;
  }

  :global(.vc-context-menu .vc-context-item--expandable[aria-expanded="true"])::after {
    content: "▴";
  }

  :global(.vc-context-menu .vc-context-submenu) {
    border-top: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
    margin: 2px 0;
    background: var(--color-bg, var(--color-surface));
  }
</style>
