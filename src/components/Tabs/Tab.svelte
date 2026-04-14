<script lang="ts">
  import { X } from "lucide-svelte";
  import type { Tab } from "../../store/tabStore";

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

  // Derive the display filename from the full path. Graph tabs use a
  // friendly label instead of the sentinel filePath.
  const filename = $derived(
    tab.type === "graph"
      ? "Graph"
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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="vc-tab"
  class:vc-tab--active={isActive}
  title={tab.filePath}
  draggable="true"
  onclick={handleClick}
  onmousedown={handleMiddleClick}
  ondragstart={handleDragStart}
  role="tab"
  aria-selected={isActive}
  tabindex={isActive ? 0 : -1}
>
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
