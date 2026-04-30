<script lang="ts">
  import { X, Home, BookOpen } from "lucide-svelte";
  import type { Tab } from "../../store/tabStore";
  import { isHomeCanvasPath, homeTabLabel } from "../../lib/homeCanvas";
  import { isDocsPagePath, docsTabLabel } from "../../lib/docsPage";

  let {
    tab,
    isActive,
    onactivate,
    onclose,
  }: {
    tab: Tab;
    isActive: boolean;
    onactivate: () => void;
    onclose: () => void;
  } = $props();

  const isHome = $derived(isHomeCanvasPath(tab.filePath));
  const isDocs = $derived(isDocsPagePath(tab.filePath));

  // Derive the display filename from the full path. Graph tabs use a
  // friendly label; the home canvas shows the vault name (#279); the
  // bundled docs page uses a fixed "Docs" label (#285).
  const filename = $derived(
    tab.type === "graph"
      ? "Graph"
      : isHome
        ? homeTabLabel(tab.filePath)
        : isDocs
          ? docsTabLabel(tab.filePath)
          : (tab.filePath.split("/").pop() ?? tab.filePath),
  );

  function handleClick(e: MouseEvent) {
    onactivate();
  }

  function handleMiddleClick(e: MouseEvent) {
    if (e.button === 1) {
      e.preventDefault();
      onclose();
    }
  }

  function handleCloseClick(e: MouseEvent) {
    e.stopPropagation();
    onclose();
  }

  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("text/vaultcore-tab", tab.id);
    e.dataTransfer.effectAllowed = "move";
  }

  // ARIA tab pattern: Enter or Space activates the focused tab. Space must
  // preventDefault to stop the default page-scroll behavior.
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onactivate();
    }
  }
</script>

<div
  class="vc-tab"
  class:vc-tab--active={isActive}
  title={tab.filePath}
  draggable="true"
  onclick={handleClick}
  onmousedown={handleMiddleClick}
  onkeydown={handleKeydown}
  ondragstart={handleDragStart}
  role="tab"
  aria-selected={isActive}
  tabindex={isActive ? 0 : -1}
>
  {#if isHome}
    <span class="vc-tab-home-icon" aria-hidden="true">
      <Home size={14} strokeWidth={1.75} />
    </span>
  {:else if isDocs}
    <span class="vc-tab-home-icon" aria-hidden="true">
      <BookOpen size={14} strokeWidth={1.75} />
    </span>
  {/if}
  <span class="vc-tab-label">{filename}</span>

  {#if tab.isDirty}
    <span class="vc-tab-dirty" aria-label="Unsaved changes"></span>
  {/if}

  <button
    class="vc-tab-close"
    onclick={handleCloseClick}
    aria-label="Close tab"
    title="Close"
    tabindex="-1"
  >
    <X size={14} />
  </button>
</div>

<style>
  .vc-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 8px;
    max-width: 160px;
    min-width: 80px;
    height: 36px;
    /* #385 — token undefined on desktop → fallback 36px equals `height`
       (byte-identical); coarse → 44px overrides `height`. */
    min-height: var(--vc-hit-target, 36px);
    box-sizing: border-box;
    cursor: pointer;
    flex-shrink: 0;
    position: relative;
    background: var(--color-bg);
    border-bottom: 2px solid transparent;
    user-select: none;
  }

  .vc-tab:hover {
    background: var(--color-surface);
  }

  .vc-tab--active {
    background: var(--color-surface);
    border-bottom-color: var(--color-accent);
  }

  .vc-tab-label {
    flex: 1;
    font-size: 14px;
    font-weight: 400;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .vc-tab--active .vc-tab-label {
    font-weight: 700;
    color: var(--color-text);
  }

  .vc-tab-dirty {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
    flex-shrink: 0;
  }

  .vc-tab-home-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .vc-tab--active .vc-tab-home-icon {
    color: var(--color-text);
  }

  .vc-tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0;
    /* Hidden by default for inactive tabs */
    opacity: 0;
    pointer-events: none;
  }

  .vc-tab--active .vc-tab-close {
    /* Always visible on active tab */
    opacity: 1;
    pointer-events: auto;
  }

  .vc-tab:hover .vc-tab-close {
    /* Visible on any hovered tab */
    opacity: 1;
    pointer-events: auto;
  }

  .vc-tab-close:hover {
    color: var(--color-error);
    background: var(--color-accent-bg);
  }
</style>
