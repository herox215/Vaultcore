<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Sidebar from "../Sidebar/Sidebar.svelte";

  const SIDEBAR_WIDTH_KEY = "vaultcore-sidebar-width";
  const DEFAULT_SIDEBAR_WIDTH = 240;
  const MIN_SIDEBAR_WIDTH = 160;
  const MAX_SIDEBAR_WIDTH = 480;

  let sidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
  let sidebarCollapsed = $state(false);
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartWidth = 0;

  // Sidebar selection state (Plan 03 will hand off to tabStore)
  let selectedPath = $state<string | null>(null);

  onMount(() => {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= MIN_SIDEBAR_WIDTH && parsed <= MAX_SIDEBAR_WIDTH) {
        sidebarWidth = parsed;
      }
    }
  });

  function persistWidth(width: number) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }

  // Divider drag-to-resize
  function handleDividerMousedown(e: MouseEvent) {
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartWidth = sidebarWidth;
  }

  function handleMousemove(e: MouseEvent) {
    if (!isDragging) return;
    const delta = e.clientX - dragStartX;
    const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, dragStartWidth + delta));
    sidebarWidth = newWidth;
  }

  function handleMouseup() {
    if (isDragging) {
      isDragging = false;
      persistWidth(sidebarWidth);
    }
  }

  onMount(() => {
    document.addEventListener("mousemove", handleMousemove);
    document.addEventListener("mouseup", handleMouseup);
    return () => {
      document.removeEventListener("mousemove", handleMousemove);
      document.removeEventListener("mouseup", handleMouseup);
    };
  });

  onDestroy(() => {
    document.removeEventListener("mousemove", handleMousemove);
    document.removeEventListener("mouseup", handleMouseup);
  });

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
  }

  function handleSelect(path: string) {
    selectedPath = path;
  }

  function handleOpenFile(path: string) {
    // Plan 03 will wire this to tabStore
    selectedPath = path;
  }
</script>

<div
  class="vc-vault-layout"
  class:vc-vault-layout--dragging={isDragging}
  style="--sidebar-width: {sidebarCollapsed ? 0 : sidebarWidth}px"
>
  <!-- Sidebar column -->
  <div
    class="vc-layout-sidebar"
    class:vc-layout-sidebar--collapsed={sidebarCollapsed}
    aria-hidden={sidebarCollapsed}
  >
    <Sidebar
      {selectedPath}
      onSelect={handleSelect}
      onOpenFile={handleOpenFile}
    />
  </div>

  <!-- Resize divider -->
  {#if !sidebarCollapsed}
    <div
      class="vc-layout-divider"
      class:vc-layout-divider--active={isDragging}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      onmousedown={handleDividerMousedown}
    ></div>
  {/if}

  <!-- Editor area -->
  <div class="vc-layout-editor">
    <!-- Sidebar collapse toggle (shown when collapsed) -->
    {#if sidebarCollapsed}
      <button
        class="vc-sidebar-expand-btn"
        onclick={toggleSidebar}
        aria-label="Expand sidebar"
        title="Expand sidebar"
      >
        &#9654;
      </button>
    {/if}

    <!-- Editor area header with collapse button -->
    <div class="vc-editor-topbar">
      {#if !sidebarCollapsed}
        <button
          class="vc-sidebar-toggle-btn"
          onclick={toggleSidebar}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          &#9664;
        </button>
      {/if}
    </div>

    <!-- Plan 03 will replace this placeholder with EditorPane / TabBar -->
    <div class="vc-editor-placeholder">
      <p>No file open</p>
      <p class="vc-editor-placeholder-hint">Select a file in the sidebar to open it.</p>
    </div>
  </div>
</div>

<style>
  .vc-vault-layout {
    display: grid;
    grid-template-columns: var(--sidebar-width, 240px) auto 1fr;
    height: 100vh;
    background: var(--color-bg);
    overflow: hidden;
  }

  .vc-vault-layout--dragging {
    cursor: col-resize;
    user-select: none;
  }

  .vc-layout-sidebar {
    overflow: hidden;
    width: var(--sidebar-width, 240px);
    transition: width 200ms ease;
    background: var(--color-bg);
    border-right: 1px solid var(--color-border);
  }

  .vc-layout-sidebar--collapsed {
    width: 0;
    border-right: none;
  }

  .vc-layout-divider {
    width: 4px;
    background: var(--color-border);
    cursor: col-resize;
    flex-shrink: 0;
    transition: background 150ms;
  }

  .vc-layout-divider:hover,
  .vc-layout-divider--active {
    background: var(--color-accent-bg);
  }

  .vc-layout-editor {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--color-surface);
    overflow: hidden;
  }

  .vc-editor-topbar {
    display: flex;
    align-items: center;
    height: 36px;
    padding: 0 8px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .vc-sidebar-toggle-btn,
  .vc-sidebar-expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 12px;
  }

  .vc-sidebar-toggle-btn:hover,
  .vc-sidebar-expand-btn:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-sidebar-expand-btn {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
  }

  .vc-editor-placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    font-size: 14px;
    gap: 8px;
  }

  .vc-editor-placeholder p {
    margin: 0;
  }

  .vc-editor-placeholder-hint {
    font-size: 12px;
  }
</style>
