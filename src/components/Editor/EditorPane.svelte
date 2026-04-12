<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { get } from "svelte/store";
  import TabBar from "../Tabs/TabBar.svelte";
  import { tabStore } from "../../store/tabStore";
  import type { Tab } from "../../store/tabStore";
  import { vaultStore } from "../../store/vaultStore";
  import { editorStore } from "../../store/editorStore";
  import { readFile, writeFile } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import { buildExtensions } from "./extensions";

  let {
    paneId,
  }: {
    paneId: "left" | "right";
  } = $props();

  // CRITICAL (Pitfall 4 from RESEARCH): EditorView instances MUST NOT be
  // wrapped in $state — store them in a module-level Map keyed by tab ID.
  // This preserves undo history across tab switches without remounting.
  // Using display: none / block to hide/show each EditorView's container div.
  const viewMap = new Map<string, EditorView>();
  // Map from tab ID to container div element
  const containerMap = new Map<string, HTMLDivElement>();

  // Local reactive state driven by store subscription
  let paneTabIds = $state<string[]>([]);
  let allTabs = $state<Tab[]>([]);
  let activeTabId = $state<string | null>(null);
  let activePane = $state<"left" | "right">("left");
  let vaultReachable = $state(true); // ERR-03 placeholder

  // EditorPane host element for drag-to-split detection
  let paneEl = $state<HTMLDivElement | undefined>();

  // Drag-to-split visual state
  let splitIndicatorSide = $state<"left" | "right" | null>(null);

  const paneTabs = $derived(
    paneTabIds
      .map((id) => allTabs.find((t) => t.id === id))
      .filter((t): t is Tab => t !== undefined)
  );

  const paneActiveTabId = $derived(
    activePane === paneId && activeTabId !== null && paneTabIds.includes(activeTabId)
      ? activeTabId
      : paneTabIds[0] ?? null
  );

  let prevActiveTabId: string | null = null;

  // Subscribe to tabStore for our pane's tabs and active state
  const unsubTab = tabStore.subscribe((state) => {
    paneTabIds = state.splitState[paneId];
    allTabs = state.tabs;
    activeTabId = state.activeTabId;
    activePane = state.splitState.activePane;
  });

  // Watch paneTabIds changes to manage EditorView lifecycle
  $effect(() => {
    const currentIds = new Set(paneTabIds);

    // Remove views for tabs no longer in this pane
    for (const [id, view] of viewMap) {
      if (!currentIds.has(id)) {
        view.destroy();
        viewMap.delete(id);
        containerMap.delete(id);
      }
    }

    // Open new tabs (create EditorView if not yet in viewMap)
    for (const tabId of paneTabIds) {
      if (!viewMap.has(tabId)) {
        const tab = allTabs.find((t) => t.id === tabId);
        if (tab) {
          createEditorView(tab);
        }
      }
    }

    // Handle active tab switch: save scroll/cursor on deactivate, show/hide
    const newActiveId = paneActiveTabId;
    if (prevActiveTabId !== newActiveId) {
      // Hide previous
      if (prevActiveTabId) {
        const prevContainer = containerMap.get(prevActiveTabId);
        if (prevContainer) {
          prevContainer.style.display = "none";
          // Save scroll position
          const prevView = viewMap.get(prevActiveTabId);
          if (prevView) {
            const scrollTop = prevView.scrollDOM.scrollTop;
            const cursor = prevView.state.selection.main.head;
            tabStore.updateScrollPos(prevActiveTabId, scrollTop, cursor);
          }
        }
      }
      // Show new active
      if (newActiveId) {
        const activeContainer = containerMap.get(newActiveId);
        if (activeContainer) {
          activeContainer.style.display = "block";
          // Restore scroll position
          const activeView = viewMap.get(newActiveId);
          const activeTab = allTabs.find((t) => t.id === newActiveId);
          if (activeView && activeTab) {
            // Restore cursor position
            if (activeTab.cursorPos > 0) {
              const pos = Math.min(activeTab.cursorPos, activeView.state.doc.length);
              activeView.dispatch({
                selection: { anchor: pos },
              });
            }
            // Restore scroll position after a microtask
            requestAnimationFrame(() => {
              activeView.scrollDOM.scrollTop = activeTab.scrollPos;
            });
            // Sync editorStore to active tab
            editorStore.syncFromTab(
              activeTab.filePath,
              activeView.state.doc.toString(),
              activeTab.lastSaved ? String(activeTab.lastSaved) : null
            );
          }
        }
      }
      prevActiveTabId = newActiveId;
    }
  });

  // Subscribe to vaultStore for vault reachability (ERR-03)
  const unsubVault = vaultStore.subscribe((state) => {
    // vaultReachable will be wired in Plan 05 — defaulting to true
    vaultReachable = true;
  });

  /**
   * Create a new EditorView for the given tab and mount it into a new container div.
   * The container is appended to the pane host element.
   * Initially hidden unless it's the active tab.
   */
  async function createEditorView(tab: Tab) {
    if (!paneEl) return;
    if (viewMap.has(tab.id)) return;

    let content = "";
    try {
      content = await readFile(tab.filePath);
    } catch (err) {
      toastStore.push({ variant: "error", message: `Failed to open file.` });
      return;
    }

    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.height = "100%";
    container.style.display = tab.id === paneActiveTabId ? "block" : "none";
    container.setAttribute("data-tab-id", tab.id);
    paneEl.appendChild(container);

    const onSave = async (text: string) => {
      try {
        const hash = await writeFile(tab.filePath, text);
        tabStore.setDirty(tab.id, false);
        editorStore.setLastSavedHash(hash);
      } catch (err) {
        toastStore.push({ variant: "error", message: "Disk full. Could not save changes." });
      }
    };

    // Mark dirty on doc change
    const onDirty = () => {
      tabStore.setDirty(tab.id, true);
    };

    const extensions = buildExtensions(onSave);
    // Add dirty listener via EditorView.updateListener
    const { EditorView: EV } = await import("@codemirror/view");
    const dirtyListener = EV.updateListener.of((update) => {
      if (update.docChanged) {
        onDirty();
      }
    });

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [...extensions, dirtyListener],
      }),
      parent: container,
    });

    viewMap.set(tab.id, view);
    containerMap.set(tab.id, container);

    // Sync editorStore if this is the active tab
    if (tab.id === paneActiveTabId) {
      editorStore.syncFromTab(tab.filePath, content, null);
      prevActiveTabId = tab.id;
    }
  }

  // Drag-to-split detection
  function handleDragover(e: DragEvent) {
    if (!e.dataTransfer) return;
    if (!e.dataTransfer.types.includes("text/vaultcore-tab")) return;
    e.preventDefault();
    if (!paneEl) return;

    const rect = paneEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const EDGE_THRESHOLD = 40;

    if (x < EDGE_THRESHOLD) {
      splitIndicatorSide = "left";
    } else if (x > rect.width - EDGE_THRESHOLD) {
      splitIndicatorSide = "right";
    } else {
      splitIndicatorSide = null;
    }
  }

  function handleDragleave() {
    splitIndicatorSide = null;
  }

  function handleDrop(e: DragEvent) {
    if (!e.dataTransfer) return;
    const draggedTabId = e.dataTransfer.getData("text/vaultcore-tab");
    if (!draggedTabId || !splitIndicatorSide) {
      splitIndicatorSide = null;
      return;
    }
    e.preventDefault();

    // T-02-11 mitigation: check MIME type before accepting
    if (!e.dataTransfer.types.includes("text/vaultcore-tab")) {
      splitIndicatorSide = null;
      return;
    }

    const targetPane = splitIndicatorSide;
    tabStore.activateTab(draggedTabId);
    tabStore.moveToPane(targetPane);
    splitIndicatorSide = null;
  }

  onDestroy(() => {
    unsubTab();
    unsubVault();
    // Destroy all EditorView instances in this pane
    for (const view of viewMap.values()) {
      view.destroy();
    }
    viewMap.clear();
    containerMap.clear();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="vc-editor-pane"
  bind:this={paneEl}
  ondragover={handleDragover}
  ondragleave={handleDragleave}
  ondrop={handleDrop}
>
  <TabBar
    {paneId}
    tabs={paneTabs}
    activeTabId={paneActiveTabId}
  />

  <!-- Editor content area — EditorView containers are appended here via JS -->
  <div class="vc-editor-content">
    {#if paneTabs.length === 0}
      <!-- Empty pane state -->
      <div class="vc-editor-empty">
        <p class="vc-editor-empty-heading">No file open</p>
        <p class="vc-editor-empty-body">Select a file from the sidebar, or drag a tab here to split the view.</p>
      </div>
    {/if}
    <!-- EditorView DOM containers are inserted here by createEditorView() -->
  </div>

  <!-- ERR-03 readonly overlay — wired in Plan 05 -->
  {#if !vaultReachable}
    <div class="vc-editor-readonly-overlay"></div>
  {/if}

  <!-- Drag-to-split indicator -->
  {#if splitIndicatorSide !== null}
    <div
      class="vc-split-indicator"
      class:vc-split-indicator--left={splitIndicatorSide === "left"}
      class:vc-split-indicator--right={splitIndicatorSide === "right"}
    ></div>
  {/if}
</div>

<style>
  .vc-editor-pane {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-width: 0;
    background: var(--color-surface);
    position: relative;
    overflow: hidden;
  }

  .vc-editor-content {
    flex: 1 1 0;
    position: relative;
    overflow: hidden;
  }

  .vc-editor-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--color-text-muted);
    font-size: 14px;
    pointer-events: none;
  }

  .vc-editor-empty-heading {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
  }

  .vc-editor-empty-body {
    margin: 0;
    font-size: 14px;
    text-align: center;
    max-width: 280px;
  }

  /* ERR-03 readonly overlay — pointer-events: none so text is still readable */
  .vc-editor-readonly-overlay {
    pointer-events: none;
    background: rgba(255, 255, 255, 0.6);
    position: absolute;
    inset: 0;
    z-index: 10;
  }

  /* Drag-to-split indicator */
  .vc-split-indicator {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 4px;
    background: var(--color-accent);
    z-index: 20;
    pointer-events: none;
  }

  .vc-split-indicator--left {
    left: 0;
  }

  .vc-split-indicator--right {
    right: 0;
  }

  /* Split fill overlay at 20% opacity */
  .vc-split-indicator::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 200px;
    background: var(--color-accent-bg);
    opacity: 0.2;
  }

  .vc-split-indicator--left::after {
    left: 4px;
  }

  .vc-split-indicator--right::after {
    right: 4px;
    left: auto;
  }
</style>
