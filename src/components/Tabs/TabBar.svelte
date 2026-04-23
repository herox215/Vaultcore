<script lang="ts">
  import Tab from "./Tab.svelte";
  import { tabStore } from "../../store/tabStore";
  import { tabLayoutStore } from "../../store/tabLayoutStore";
  import type { Tab as TabType } from "../../store/tabStore";

  let {
    paneId,
    tabs,
    activeTabId,
  }: {
    paneId: "left" | "right";
    tabs: TabType[];
    activeTabId: string | null;
  } = $props();

  // Drag-to-reorder state
  let dragOverIndex = $state<number | null>(null);

  function handleActivate(tabId: string) {
    tabStore.activateTab(tabId);
  }

  function handleClose(tabId: string) {
    tabStore.closeTab(tabId);
  }

  function handleDragover(e: DragEvent) {
    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes("text/vaultcore-tab")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // Determine insertion index from mouse X position
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const tabWidth = rect.width / Math.max(tabs.length, 1);
    dragOverIndex = Math.min(Math.round(x / tabWidth), tabs.length);
  }

  function handleDragleave() {
    dragOverIndex = null;
  }

  function handleDrop(e: DragEvent) {
    if (!e.dataTransfer) return;
    const draggedTabId = e.dataTransfer.getData("text/vaultcore-tab");
    if (!draggedTabId) return;
    e.preventDefault();

    // Reorder: move draggedTabId to dragOverIndex position in this pane
    const currentIds = [...tabs.map((t) => t.id)];
    const fromIdx = currentIds.indexOf(draggedTabId);

    if (fromIdx !== -1 && dragOverIndex !== null) {
      currentIds.splice(fromIdx, 1);
      const insertAt = dragOverIndex > fromIdx ? dragOverIndex - 1 : dragOverIndex;
      currentIds.splice(insertAt, 0, draggedTabId);

      // Apply reorder to store
      tabLayoutStore.reorderPane(paneId, currentIds);
    } else if (fromIdx === -1 && draggedTabId) {
      // Tab from other pane — move it to this pane
      tabStore.activateTab(draggedTabId);
      tabStore.moveToPane(paneId);
    }

    dragOverIndex = null;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="vc-tabbar"
  role="tablist"
  aria-label="{paneId} pane tabs"
  tabindex="0"
  ondragover={handleDragover}
  ondragleave={handleDragleave}
  ondrop={handleDrop}
>
  {#each tabs as tab, i (tab.id)}
    {#if dragOverIndex === i}
      <div class="vc-tabbar-insert-indicator"></div>
    {/if}
    <Tab
      {tab}
      isActive={tab.id === activeTabId}
      onactivate={() => handleActivate(tab.id)}
      onclose={() => handleClose(tab.id)}
    />
  {/each}
  {#if dragOverIndex === tabs.length}
    <div class="vc-tabbar-insert-indicator"></div>
  {/if}
</div>

<style>
  .vc-tabbar {
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 36px;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    overflow-x: auto;
    scrollbar-width: none;
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .vc-tabbar::-webkit-scrollbar {
    display: none;
  }

  .vc-tabbar-insert-indicator {
    width: 2px;
    height: 100%;
    background: var(--color-accent);
    flex-shrink: 0;
  }
</style>
