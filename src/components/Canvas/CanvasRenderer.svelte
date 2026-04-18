<script lang="ts">
  // Pure-presentation canvas renderer — #156. Renders the world DOM (nodes +
  // edge SVG overlay) from a CanvasDoc + camera transform. Used by
  // CanvasView.svelte (interactive) and CanvasEmbedWidget (read-only embed).
  //
  // Design:
  // - All state (selection, hover, edit, draft) flows in via props. The
  //   renderer does not own any of it — CanvasView keeps the state machine.
  // - All user interactions surface as optional callbacks. When unset (embed
  //   use) the handlers no-op and the resize/edge handles + editing inputs
  //   are omitted entirely via `interactive={false}`.
  // - $derived computations (orderedNodes, resolvedEdges, draftPathD) live
  //   here because they are pure functions of doc + draft.

  import { convertFileSrc } from "@tauri-apps/api/core";
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
  import { SIDES } from "../../lib/canvas/geometry";
  import {
    isImageFile,
    isMarkdownFile,
    resolveVaultAbs,
  } from "../../lib/canvas/embed";
  import {
    resolveEdges as resolveEdgesPure,
    draftPath as draftPathPure,
  } from "../../lib/canvas/edgeResolver";
  import type { DraftEdge } from "../../lib/canvas/pointerMode";
  import { tokenizeCanvasText } from "../../lib/canvas/textTokens";
  import { resolveTarget } from "../Editor/wikiLink";

  // Tiny use:-action to focus + select an input on mount (the inline
  // edits for link URL / group label rely on this rather than the
  // `autofocus` attribute, which Svelte lints against for a11y).
  function focusOnMount(el: HTMLInputElement) {
    el.focus();
    el.select();
  }

  interface Props {
    doc: CanvasDoc;
    camX?: number;
    camY?: number;
    zoom?: number;
    vaultPath?: string | null;
    mdPreviews?: Record<string, string>;

    interactive?: boolean;

    selectedNodeId?: string | null;
    selectedEdgeId?: string | null;
    hoveredNodeId?: string | null;
    editingNodeId?: string | null;
    editingEdgeId?: string | null;
    draft?: DraftEdge | null;

    editingTextareaEl?: HTMLTextAreaElement | null;
    editingEdgeLabelEl?: HTMLInputElement | null;

    onNodePointerDown?: (e: PointerEvent, node: CanvasNode) => void;
    onNodeDblClick?: (e: MouseEvent, node: CanvasNode) => void;
    onNodeHoverEnter?: (node: CanvasNode) => void;
    onNodeHoverLeave?: (node: CanvasNode) => void;
    onResizePointerDown?: (e: PointerEvent, node: CanvasNode) => void;
    onHandlePointerDown?: (e: PointerEvent, node: CanvasNode, side: CanvasSide) => void;
    onCardKey?: (e: KeyboardEvent, action: () => void) => void;
    onStartEditText?: (node: CanvasTextNode) => void;
    onTextEdit?: (e: Event, node: CanvasTextNode) => void;
    onTextBlur?: () => void;
    onOpenFileNode?: (node: CanvasFileNode) => void;
    onOpenLinkNode?: (node: CanvasLinkNode) => void;
    onOpenWikiTarget?: (target: string) => void;
    onSelectNode?: (node: CanvasNode) => void;

    onEdgeHitPointerDown?: (e: PointerEvent, edge: CanvasEdge) => void;
    onEdgeDblClick?: (e: MouseEvent, edge: CanvasEdge) => void;
    onEdgeLabelInput?: (e: Event, edge: CanvasEdge) => void;
    onEdgeLabelBlur?: () => void;
    onStartEditEdgeLabel?: (edge: CanvasEdge) => void;
    onStopEditingEdge?: () => void;

    /** Right-click surfaces (#164). When omitted the renderer stays inert —
     *  embed use doesn't need a menu. */
    onNodeContextMenu?: (e: MouseEvent, node: CanvasNode) => void;
    onEdgeContextMenu?: (e: MouseEvent, edge: CanvasEdge) => void;

    /** Inline edits for link URL / group label (#166). `editingNodeId`
     *  doubles as the “which node is being edited” state — the renderer
     *  branches on `node.type` to pick the right input. */
    onLinkUrlInput?: (e: Event, node: CanvasLinkNode) => void;
    onGroupLabelInput?: (e: Event, node: CanvasGroupNode) => void;
    onStopEditingNode?: () => void;
  }

  let {
    doc,
    camX = 0,
    camY = 0,
    zoom = 1,
    vaultPath = null,
    mdPreviews = {},
    interactive = false,
    selectedNodeId = null,
    selectedEdgeId = null,
    hoveredNodeId = null,
    editingNodeId = null,
    editingEdgeId = null,
    draft = null,
    editingTextareaEl = $bindable(null),
    editingEdgeLabelEl = $bindable(null),
    onNodePointerDown,
    onNodeDblClick,
    onNodeHoverEnter,
    onNodeHoverLeave,
    onResizePointerDown,
    onHandlePointerDown,
    onCardKey,
    onStartEditText,
    onTextEdit,
    onTextBlur,
    onOpenFileNode,
    onOpenLinkNode,
    onOpenWikiTarget,
    onSelectNode,
    onEdgeHitPointerDown,
    onEdgeDblClick,
    onEdgeLabelInput,
    onEdgeLabelBlur,
    onStartEditEdgeLabel,
    onStopEditingEdge,
    onNodeContextMenu,
    onEdgeContextMenu,
    onLinkUrlInput,
    onGroupLabelInput,
    onStopEditingNode,
  }: Props = $props();

  // Groups render first so other nodes stack visually on top of them.
  // Two-pass sort keeps doc.nodes order stable within each band so picks
  // based on DOM order (hit-testing) stay predictable.
  let orderedNodes = $derived([
    ...doc.nodes.filter((n) => n.type === "group"),
    ...doc.nodes.filter((n) => n.type !== "group"),
  ]);
  let resolvedEdges = $derived(resolveEdgesPure(doc));
  let draftPathD = $derived(draftPathPure(doc, draft));
</script>

<div
  class="vc-canvas-world"
  class:vc-canvas-readonly={!interactive}
  style:transform={`translate(${camX}px, ${camY}px) scale(${zoom})`}
>
  <svg
    class="vc-canvas-edges"
    overflow="visible"
    aria-hidden="true"
  >
    <defs>
      {#each resolvedEdges as re (`marker-${re.edge.id}`)}
        {@const markerColor = selectedEdgeId === re.edge.id
          ? "var(--color-accent)"
          : (re.edge.color ?? "var(--color-border-strong, #9ca3af)")}
        <marker
          id={`vc-canvas-arrow-${re.edge.id}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" style:fill={markerColor} />
        </marker>
      {/each}
    </defs>
    {#each resolvedEdges as re (re.edge.id)}
      {@const arrowEnd = re.edge.toEnd !== "none"}
      {@const arrowStart = re.edge.fromEnd === "arrow"}
      {#if interactive}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <path
          class="vc-canvas-edge-hit"
          d={re.path}
          data-edge-id={re.edge.id}
          onpointerdown={(e) => onEdgeHitPointerDown?.(e, re.edge)}
          ondblclick={(e) => onEdgeDblClick?.(e, re.edge)}
          oncontextmenu={(e) => onEdgeContextMenu?.(e, re.edge)}
        />
      {/if}
      <path
        class="vc-canvas-edge"
        class:vc-canvas-edge-selected={selectedEdgeId === re.edge.id}
        d={re.path}
        style:color={re.edge.color ?? "var(--color-border-strong, #9ca3af)"}
        marker-end={arrowEnd ? `url(#vc-canvas-arrow-${re.edge.id})` : null}
        marker-start={arrowStart ? `url(#vc-canvas-arrow-${re.edge.id})` : null}
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
    {#if interactive && editingEdgeId === re.edge.id}
      <input
        bind:this={editingEdgeLabelEl}
        class="vc-canvas-edge-label-input"
        value={re.edge.label ?? ""}
        style:left={`${re.mid.x}px`}
        style:top={`${re.mid.y}px`}
        oninput={(e) => onEdgeLabelInput?.(e, re.edge)}
        onblur={() => onEdgeLabelBlur?.()}
        onpointerdown={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            onStopEditingEdge?.();
          }
        }}
      />
    {:else if re.edge.label}
      {#if interactive}
        <div
          class="vc-canvas-edge-label"
          class:vc-canvas-edge-label-selected={selectedEdgeId === re.edge.id}
          style:left={`${re.mid.x}px`}
          style:top={`${re.mid.y}px`}
          data-edge-id={re.edge.id}
          onpointerdown={(e) => onEdgeHitPointerDown?.(e, re.edge)}
          ondblclick={(e) => onEdgeDblClick?.(e, re.edge)}
          oncontextmenu={(e) => onEdgeContextMenu?.(e, re.edge)}
          onkeydown={(e) => onCardKey?.(e, () => onStartEditEdgeLabel?.(re.edge))}
          role="button"
          tabindex="0"
        >
          {re.edge.label}
        </div>
      {:else}
        <div
          class="vc-canvas-edge-label"
          style:left={`${re.mid.x}px`}
          style:top={`${re.mid.y}px`}
          data-edge-id={re.edge.id}
        >
          {re.edge.label}
        </div>
      {/if}
    {/if}
  {/each}

  {#each orderedNodes as node (node.id)}
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
        onpointerdown={interactive ? (e) => onNodePointerDown?.(e, node) : undefined}
        ondblclick={interactive ? (e) => onNodeDblClick?.(e, node) : undefined}
        oncontextmenu={interactive ? (e) => onNodeContextMenu?.(e, node) : undefined}
        onkeydown={interactive ? (e) => onCardKey?.(e, () => onStartEditText?.(node as CanvasTextNode)) : undefined}
        onpointerenter={interactive ? () => onNodeHoverEnter?.(node) : undefined}
        onpointerleave={interactive ? () => onNodeHoverLeave?.(node) : undefined}
        role={interactive ? "button" : undefined}
        tabindex={interactive ? 0 : undefined}
      >
        {#if interactive && editingNodeId === node.id}
          <textarea
            bind:this={editingTextareaEl}
            class="vc-canvas-node-textarea"
            value={(node as CanvasTextNode).text}
            oninput={(e) => onTextEdit?.(e, node as CanvasTextNode)}
            onblur={() => onTextBlur?.()}
            onpointerdown={(e) => e.stopPropagation()}
            ondblclick={(e) => e.stopPropagation()}
          ></textarea>
        {:else}
          {@const rawText = (node as CanvasTextNode).text}
          {@const segments = tokenizeCanvasText(rawText)}
          <div class="vc-canvas-node-content">
            {#if rawText.length === 0}
              Empty card
            {:else}
              {#each segments as seg, i (i)}
                {#if seg.kind === "text"}{seg.text}{:else if seg.kind === "link"}
                  {@const resolved = resolveTarget(seg.target)}
                  {#if interactive}
                    <button
                      type="button"
                      class="vc-canvas-link"
                      class:vc-canvas-link-resolved={resolved !== null}
                      class:vc-canvas-link-unresolved={resolved === null}
                      data-wiki-target={seg.target}
                      onpointerdown={(e) => e.stopPropagation()}
                      onclick={(e) => { e.stopPropagation(); onOpenWikiTarget?.(seg.target); }}
                    >{seg.display}</button>
                  {:else}
                    <span
                      class="vc-canvas-link"
                      class:vc-canvas-link-resolved={resolved !== null}
                      class:vc-canvas-link-unresolved={resolved === null}
                      data-wiki-target={seg.target}
                    >{seg.display}</span>
                  {/if}
                {:else if seg.kind === "image"}
                  {@const imgResolved = resolveTarget(seg.target)}
                  {#if imgResolved && vaultPath}
                    <img
                      class="vc-canvas-inline-image"
                      src={convertFileSrc(resolveVaultAbs(vaultPath, imgResolved))}
                      alt={seg.target}
                      draggable="false"
                    />
                  {:else}
                    <span class="vc-canvas-link vc-canvas-link-unresolved">![[{seg.target}]]</span>
                  {/if}
                {/if}
              {/each}
            {/if}
          </div>
        {/if}
        {#if interactive}
          <div
            class="vc-canvas-resize-handle"
            onpointerdown={(e) => onResizePointerDown?.(e, node)}
            role="presentation"
          ></div>
          {#each SIDES as side (side)}
            <button
              type="button"
              class="vc-canvas-edge-handle vc-canvas-edge-handle-{side}"
              class:vc-canvas-edge-handle-active={draft?.targetNodeId === node.id && draft?.targetSide === side}
              aria-label={`Create edge from ${side}`}
              data-edge-handle={side}
              onpointerdown={(e) => onHandlePointerDown?.(e, node, side)}
            ></button>
          {/each}
        {/if}
      </div>
    {:else if node.type === "file"}
      {@const fileNode = node as CanvasFileNode}
      {@const abs = vaultPath ? resolveVaultAbs(vaultPath, fileNode.file) : null}
      <div
        class="vc-canvas-node vc-canvas-node-file"
        class:vc-canvas-node-selected={selectedNodeId === node.id}
        class:vc-canvas-node-hovered={hoveredNodeId === node.id || draft?.fromNodeId === node.id}
        style:left={`${node.x}px`}
        style:top={`${node.y}px`}
        style:width={`${node.width}px`}
        style:height={`${node.height}px`}
        data-node-id={node.id}
        data-node-type="file"
        onpointerdown={interactive ? (e) => onNodePointerDown?.(e, node) : undefined}
        oncontextmenu={interactive ? (e) => onNodeContextMenu?.(e, node) : undefined}
        onkeydown={interactive ? (e) => onCardKey?.(e, () => onOpenFileNode?.(fileNode)) : undefined}
        onpointerenter={interactive ? () => onNodeHoverEnter?.(node) : undefined}
        onpointerleave={interactive ? () => onNodeHoverLeave?.(node) : undefined}
        role={interactive ? "button" : undefined}
        tabindex={interactive ? 0 : undefined}
      >
        {#if isImageFile(fileNode.file) && abs}
          <img
            class="vc-canvas-node-image"
            src={convertFileSrc(abs)}
            alt={fileNode.file}
            draggable="false"
            data-canvas-image="true"
          />
          {#if interactive}
            <button
              type="button"
              class="vc-canvas-node-open vc-canvas-node-open-overlay"
              data-canvas-open="image"
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => { e.stopPropagation(); onOpenFileNode?.(fileNode); }}
            >
              Open
            </button>
          {/if}
        {:else if isMarkdownFile(fileNode.file)}
          <div class="vc-canvas-node-file-header" data-canvas-file={fileNode.file}>
            <span class="vc-canvas-node-file-name">{fileNode.file}</span>
            {#if interactive}
              <button
                type="button"
                class="vc-canvas-node-open"
                data-canvas-open="md"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => { e.stopPropagation(); onOpenFileNode?.(fileNode); }}
              >
                Open
              </button>
            {/if}
          </div>
          {#if mdPreviews[fileNode.file]}
            <div class="vc-canvas-node-md markdown-body">{@html mdPreviews[fileNode.file]}</div>
          {:else}
            <div class="vc-canvas-node-md vc-canvas-node-md-loading">Loading preview…</div>
          {/if}
        {:else}
          <div class="vc-canvas-node-file-header" data-canvas-file={fileNode.file}>
            <span class="vc-canvas-node-file-name">{fileNode.file}</span>
            {#if interactive}
              <button
                type="button"
                class="vc-canvas-node-open"
                data-canvas-open="file"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => { e.stopPropagation(); onOpenFileNode?.(fileNode); }}
              >
                Open
              </button>
            {/if}
          </div>
          <div class="vc-canvas-node-file-body">
            Attached file
          </div>
        {/if}
        {#if interactive}
          <div
            class="vc-canvas-resize-handle"
            onpointerdown={(e) => onResizePointerDown?.(e, node)}
            role="presentation"
          ></div>
          {#each SIDES as side (side)}
            <button
              type="button"
              class="vc-canvas-edge-handle vc-canvas-edge-handle-{side}"
              class:vc-canvas-edge-handle-active={draft?.targetNodeId === node.id && draft?.targetSide === side}
              aria-label={`Create edge from ${side}`}
              data-edge-handle={side}
              onpointerdown={(e) => onHandlePointerDown?.(e, node, side)}
            ></button>
          {/each}
        {/if}
      </div>
    {:else if node.type === "link"}
      {@const linkNode = node as CanvasLinkNode}
      <div
        class="vc-canvas-node vc-canvas-node-link"
        class:vc-canvas-node-selected={selectedNodeId === node.id}
        class:vc-canvas-node-hovered={hoveredNodeId === node.id || draft?.fromNodeId === node.id}
        style:left={`${node.x}px`}
        style:top={`${node.y}px`}
        style:width={`${node.width}px`}
        style:height={`${node.height}px`}
        data-node-id={node.id}
        data-node-type="link"
        onpointerdown={interactive ? (e) => onNodePointerDown?.(e, node) : undefined}
        oncontextmenu={interactive ? (e) => onNodeContextMenu?.(e, node) : undefined}
        onkeydown={interactive ? (e) => onCardKey?.(e, () => onOpenLinkNode?.(linkNode)) : undefined}
        onpointerenter={interactive ? () => onNodeHoverEnter?.(node) : undefined}
        onpointerleave={interactive ? () => onNodeHoverLeave?.(node) : undefined}
        role={interactive ? "button" : undefined}
        tabindex={interactive ? 0 : undefined}
      >
        <div class="vc-canvas-node-file-header">
          {#if interactive && editingNodeId === node.id}
            <input
              type="url"
              class="vc-canvas-node-link-url-input"
              value={linkNode.url}
              oninput={(e) => onLinkUrlInput?.(e, linkNode)}
              onblur={() => onStopEditingNode?.()}
              onpointerdown={(e) => e.stopPropagation()}
              ondblclick={(e) => e.stopPropagation()}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  onStopEditingNode?.();
                }
              }}
              aria-label="Link-URL bearbeiten"
              use:focusOnMount
            />
          {:else}
            <span class="vc-canvas-node-link-url" title={linkNode.url}>{linkNode.url}</span>
            {#if interactive}
              <button
                type="button"
                class="vc-canvas-node-open"
                data-canvas-open="link"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => { e.stopPropagation(); onOpenLinkNode?.(linkNode); }}
              >
                Open
              </button>
            {/if}
          {/if}
        </div>
        <div class="vc-canvas-node-file-body">External link</div>
        {#if interactive}
          <div
            class="vc-canvas-resize-handle"
            onpointerdown={(e) => onResizePointerDown?.(e, node)}
            role="presentation"
          ></div>
          {#each SIDES as side (side)}
            <button
              type="button"
              class="vc-canvas-edge-handle vc-canvas-edge-handle-{side}"
              class:vc-canvas-edge-handle-active={draft?.targetNodeId === node.id && draft?.targetSide === side}
              aria-label={`Create edge from ${side}`}
              data-edge-handle={side}
              onpointerdown={(e) => onHandlePointerDown?.(e, node, side)}
            ></button>
          {/each}
        {/if}
      </div>
    {:else if node.type === "group"}
      {@const groupNode = node as CanvasGroupNode}
      <div
        class="vc-canvas-node vc-canvas-node-group"
        class:vc-canvas-node-selected={selectedNodeId === node.id}
        class:vc-canvas-node-hovered={hoveredNodeId === node.id || draft?.fromNodeId === node.id}
        style:left={`${node.x}px`}
        style:top={`${node.y}px`}
        style:width={`${node.width}px`}
        style:height={`${node.height}px`}
        style:background-color={groupNode.background
          ? `color-mix(in srgb, ${groupNode.background} var(--vc-group-tint-strength), transparent)`
          : null}
        data-node-id={node.id}
        data-node-type="group"
        onpointerdown={interactive ? (e) => onNodePointerDown?.(e, node) : undefined}
        oncontextmenu={interactive ? (e) => onNodeContextMenu?.(e, node) : undefined}
        onpointerenter={interactive ? () => onNodeHoverEnter?.(node) : undefined}
        onpointerleave={interactive ? () => onNodeHoverLeave?.(node) : undefined}
        role="group"
        aria-label={groupNode.label ?? "Group"}
      >
        {#if interactive && editingNodeId === node.id}
          <input
            type="text"
            class="vc-canvas-node-group-label-input"
            value={groupNode.label ?? ""}
            oninput={(e) => onGroupLabelInput?.(e, groupNode)}
            onblur={() => onStopEditingNode?.()}
            onpointerdown={(e) => e.stopPropagation()}
            ondblclick={(e) => e.stopPropagation()}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                onStopEditingNode?.();
              }
            }}
            placeholder="Label"
            aria-label="Gruppen-Label bearbeiten"
            use:focusOnMount
          />
        {:else if groupNode.label}
          <div class="vc-canvas-node-group-label">{groupNode.label}</div>
        {/if}
        {#if interactive}
          <div
            class="vc-canvas-resize-handle"
            onpointerdown={(e) => onResizePointerDown?.(e, node)}
            role="presentation"
          ></div>
          {#each SIDES as side (side)}
            <button
              type="button"
              class="vc-canvas-edge-handle vc-canvas-edge-handle-{side}"
              class:vc-canvas-edge-handle-active={draft?.targetNodeId === node.id && draft?.targetSide === side}
              aria-label={`Create edge from ${side}`}
              data-edge-handle={side}
              onpointerdown={(e) => onHandlePointerDown?.(e, node, side)}
            ></button>
          {/each}
        {/if}
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
        onpointerdown={interactive ? (e) => onNodePointerDown?.(e, node) : undefined}
        oncontextmenu={interactive ? (e) => onNodeContextMenu?.(e, node) : undefined}
        onkeydown={interactive ? (e) => onCardKey?.(e, () => onSelectNode?.(node)) : undefined}
        onpointerenter={interactive ? () => onNodeHoverEnter?.(node) : undefined}
        onpointerleave={interactive ? () => onNodeHoverLeave?.(node) : undefined}
        role={interactive ? "button" : undefined}
        tabindex={interactive ? 0 : undefined}
      >
        <div class="vc-canvas-node-content">
          <em>{node.type}</em>
        </div>
        {#if interactive}
          {#each SIDES as side (side)}
            <button
              type="button"
              class="vc-canvas-edge-handle vc-canvas-edge-handle-{side}"
              class:vc-canvas-edge-handle-active={draft?.targetNodeId === node.id && draft?.targetSide === side}
              aria-label={`Create edge from ${side}`}
              data-edge-handle={side}
              onpointerdown={(e) => onHandlePointerDown?.(e, node, side)}
            ></button>
          {/each}
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
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

  .vc-canvas-readonly .vc-canvas-edge-label {
    pointer-events: none;
    cursor: default;
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

  .vc-canvas-readonly .vc-canvas-node {
    cursor: default;
    user-select: text;
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

  .vc-canvas-link {
    display: inline;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }

  .vc-canvas-link-resolved {
    color: var(--color-accent, #4078c0);
  }

  .vc-canvas-link-unresolved {
    color: var(--color-text-muted, #888);
    text-decoration-style: dashed;
  }

  .vc-canvas-readonly .vc-canvas-link {
    cursor: default;
    pointer-events: none;
  }

  .vc-canvas-inline-image {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 4px 0;
  }

  .vc-canvas-node-file,
  .vc-canvas-node-link {
    overflow: hidden;
  }

  .vc-canvas-node-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    pointer-events: none;
    background: #000;
  }

  .vc-canvas-node-file-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-border);
    font-size: 12px;
    color: var(--color-text-muted);
    background: var(--color-surface);
    flex: 0 0 auto;
  }

  .vc-canvas-node-file-name,
  .vc-canvas-node-link-url {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }

  .vc-canvas-node-open {
    flex: 0 0 auto;
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    cursor: pointer;
  }

  .vc-canvas-node-open:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .vc-canvas-node-open-overlay {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 3;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    border-color: rgba(255, 255, 255, 0.35);
  }

  .vc-canvas-node-open-overlay:hover {
    background: rgba(0, 0, 0, 0.75);
  }

  .vc-canvas-node-file-body {
    padding: 8px;
    font-size: 13px;
    color: var(--color-text-muted);
    flex: 1;
    overflow: auto;
  }

  .vc-canvas-node-md {
    padding: 8px;
    font-size: 13px;
    color: var(--color-text);
    flex: 1;
    overflow: auto;
    line-height: 1.45;
  }

  .vc-canvas-node-md-loading {
    color: var(--color-text-muted);
    font-style: italic;
  }

  .vc-canvas-node-group {
    --vc-group-tint-strength: 18%;
    background: var(--color-accent-bg, rgba(64, 120, 192, 0.08));
    border-style: dashed;
    cursor: move;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .vc-canvas-readonly .vc-canvas-node-group {
    cursor: default;
  }

  .vc-canvas-node-group-label {
    position: absolute;
    top: -24px;
    left: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 2px 8px;
    pointer-events: none;
  }

  .vc-canvas-node-group-label-input {
    position: absolute;
    top: -24px;
    left: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    padding: 2px 8px;
    pointer-events: auto;
    outline: none;
    font-family: inherit;
  }

  .vc-canvas-node-link-url-input {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    padding: 2px 6px;
    outline: none;
    font-family: inherit;
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
  :global(.vc-canvas-drafting) .vc-canvas-edge-handle {
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
</style>
