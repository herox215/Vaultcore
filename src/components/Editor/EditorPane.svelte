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
  import { readFile, writeFile, mergeExternalChange } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import { buildExtensions } from "./extensions";
  import { listenFileChange, listenVaultStatus, type FileChangePayload } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";

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
  // ERR-03: vault reachability — driven by vaultStore.vaultReachable
  let vaultReachable = $state(true);

  // Watcher event unlisten handles
  let unlistenFileChange: UnlistenFn | null = null;
  let unlistenVaultStatus: UnlistenFn | null = null;

  // EditorPane host element for drag-to-split detection
  let paneEl = $state<HTMLDivElement | undefined>();
  // Inner content area where EditorView containers are appended
  let contentEl = $state<HTMLDivElement | undefined>();

  // Drag-to-split visual state
  let splitIndicatorSide = $state<"left" | "right" | null>(null);

  // ERR-04: Disk-full toast debounce — max one toast per 30 seconds
  let lastDiskFullToast = 0;
  const DISK_FULL_DEBOUNCE_MS = 30_000;

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
    // Sync visibility using values directly from the store state —
    // $derived (paneActiveTabId) may not have recomputed yet after
    // setting $state variables above.
    const paneIds = state.splitState[paneId];
    const activeForPane = (state.splitState.activePane === paneId
      && state.activeTabId !== null
      && paneIds.includes(state.activeTabId))
        ? state.activeTabId
        : paneIds[0] ?? null;
    syncVisibility(activeForPane, state.tabs);
  });

  /**
   * Show only the active tab's container, hide all others.
   * Takes the active ID and tabs as parameters to avoid relying on
   * $derived which may be stale when called from the store subscription.
   */
  function syncVisibility(activeId: string | null, tabs: Tab[]) {
    for (const [id, container] of containerMap) {
      container.style.display = id === activeId ? "block" : "none";
    }

    // Save scroll/cursor when switching away from a tab
    if (prevActiveTabId && prevActiveTabId !== activeId) {
      const prevView = viewMap.get(prevActiveTabId);
      if (prevView) {
        try {
          const scrollTop = prevView.scrollDOM.scrollTop;
          const cursor = prevView.state.selection.main.head;
          tabStore.updateScrollPos(prevActiveTabId, scrollTop, cursor);
        } catch (_) { /* view may have been destroyed */ }
      }
    }

    // Restore scroll/cursor when switching to a tab
    if (activeId && activeId !== prevActiveTabId) {
      const activeView = viewMap.get(activeId);
      const activeTab = tabs.find((t) => t.id === activeId);
      if (activeView && activeTab) {
        if (activeTab.cursorPos > 0) {
          const pos = Math.min(activeTab.cursorPos, activeView.state.doc.length);
          activeView.dispatch({ selection: { anchor: pos } });
        }
        requestAnimationFrame(() => {
          activeView.scrollDOM.scrollTop = activeTab.scrollPos;
        });
        editorStore.syncFromTab(
          activeTab.filePath,
          activeView.state.doc.toString(),
          activeTab.lastSaved ? String(activeTab.lastSaved) : null
        );
      }
    }

    prevActiveTabId = activeId;
  }

  // Manage EditorView lifecycle — create/destroy views when tabs change
  $effect(() => {
    const currentIds = new Set(paneTabIds);

    // Remove views for tabs no longer in this pane
    for (const [id, view] of viewMap) {
      if (!currentIds.has(id)) {
        view.destroy();
        viewMap.delete(id);
        const container = containerMap.get(id);
        if (container) container.remove();
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

    // Also sync here for when the effect runs after containerMap changes
    syncVisibility(paneActiveTabId, allTabs);
  });

  // Subscribe to vaultStore for vault reachability (ERR-03)
  const unsubVault = vaultStore.subscribe((state) => {
    vaultReachable = state.vaultReachable;
  });

  /**
   * Create a new EditorView for the given tab and mount it into a new container div.
   * The container is appended to the pane host element.
   * Initially hidden unless it's the active tab.
   */
  async function createEditorView(tab: Tab) {
    if (!contentEl) return;
    if (viewMap.has(tab.id)) return;

    let content = "";
    try {
      content = await readFile(tab.filePath);
    } catch (err) {
      toastStore.push({ variant: "error", message: `Failed to open file.` });
      return;
    }

    // Initialize lastSavedContent snapshot for three-way merge base
    tabStore.setLastSavedContent(tab.id, content);

    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.inset = "0";
    container.style.display = "none"; // syncVisibility() will show it if active
    container.setAttribute("data-tab-id", tab.id);
    contentEl.appendChild(container);

    const onSave = async (text: string) => {
      // ERR-03: skip auto-save when vault is unreachable
      if (!vaultReachable) return;

      try {
        const hash = await writeFile(tab.filePath, text);
        tabStore.setDirty(tab.id, false);
        tabStore.setLastSavedContent(tab.id, text);
        editorStore.setLastSavedHash(hash);
      } catch (err: unknown) {
        // ERR-04: disk-full error — preserve buffer, debounce toast
        const isVaultErr = err && typeof err === "object" && "kind" in err;
        const isDiskFull = isVaultErr && (err as { kind: string }).kind === "DiskFull";

        if (isDiskFull) {
          const now = Date.now();
          if (now - lastDiskFullToast > DISK_FULL_DEBOUNCE_MS) {
            lastDiskFullToast = now;
            toastStore.push({ variant: "error", message: "Disk full. Could not save changes." });
          }
          // Keep tab dirty so auto-save retries; do NOT clear editor buffer
          tabStore.setDirty(tab.id, true);
        } else {
          toastStore.push({ variant: "error", message: "Disk full. Could not save changes." });
        }
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

    // Now that the container and view are in the maps, sync visibility.
    // This is the critical call — the $effect that triggered createEditorView
    // ran before the async work finished, so it couldn't show this container.
    // Compute activeId inline from $state vars (same logic as paneActiveTabId).
    const currentActiveId = (activePane === paneId && activeTabId !== null && paneTabIds.includes(activeTabId))
      ? activeTabId
      : paneTabIds[0] ?? null;
    syncVisibility(currentActiveId, allTabs);

    // Sync editorStore if this is the active tab
    if (tab.id === paneActiveTabId) {
      editorStore.syncFromTab(tab.filePath, content, null);
    }
  }

  // ─── Watcher event handling ────────────────────────────────────────────────

  /**
   * Handle external file changes detected by the Rust file watcher.
   * Only processes events for files open in THIS pane's EditorView Map.
   */
  async function handleExternalFileChange(payload: FileChangePayload) {
    const { path, kind, new_path } = payload;

    if (kind === "modify") {
      // Check if this pane has an EditorView for the modified file
      const tabWithPath = allTabs.find((t) => t.filePath === path && paneTabIds.includes(t.id));
      if (!tabWithPath || !viewMap.has(tabWithPath.id)) return;

      const view = viewMap.get(tabWithPath.id)!;
      const editorContent = view.state.doc.toString();
      const lastSavedContent = tabWithPath.lastSavedContent;
      const filename = path.split("/").pop() ?? path;

      try {
        const result = await mergeExternalChange(path, editorContent, lastSavedContent);

        if (result.outcome === "clean") {
          // Replace editor content with merged result
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: result.merged_content },
          });
          // Update lastSavedContent to the merged result
          tabStore.setLastSavedContent(tabWithPath.id, result.merged_content);
          toastStore.push({
            variant: "clean-merge",
            message: `Externe Änderungen wurden in ${filename} eingebunden.`,
          });
        } else {
          // Conflict: keep editor content as-is, update base snapshot
          tabStore.setLastSavedContent(tabWithPath.id, editorContent);
          toastStore.push({
            variant: "conflict",
            message: `Konflikt in ${filename} – lokale Version behalten.`,
          });
        }
      } catch (_err) {
        // If merge command fails (e.g. file deleted between watcher event and read),
        // silently ignore — the delete event will handle cleanup
      }
    } else if (kind === "delete") {
      // If the deleted file is open in this pane, destroy its EditorView and remove from Map
      const tabWithPath = allTabs.find((t) => t.filePath === path && paneTabIds.includes(t.id));
      if (tabWithPath) {
        const view = viewMap.get(tabWithPath.id);
        if (view) {
          view.destroy();
          viewMap.delete(tabWithPath.id);
        }
        const container = containerMap.get(tabWithPath.id);
        if (container) {
          container.remove();
          containerMap.delete(tabWithPath.id);
        }
        // tabStore.closeByPath is called by Sidebar — don't double-close
      }
    } else if (kind === "rename" && new_path) {
      // Update the Map key from old path to new path
      const tabWithPath = allTabs.find((t) => t.filePath === path && paneTabIds.includes(t.id));
      if (tabWithPath) {
        // The tabStore.updateFilePath() call from Sidebar will update tab.filePath.
        // The viewMap is keyed by tabId, not filePath, so no Map rekeying needed.
      }
    }
  }

  /**
   * Handle vault status events (ERR-03: vault unmount/reconnect).
   */
  function handleVaultStatus(payload: { reachable: boolean }) {
    if (!payload.reachable) {
      vaultStore.setVaultReachable(false);
      toastStore.push({ variant: "error", message: "Vault unavailable. Editing disabled." });
    } else {
      vaultStore.setVaultReachable(true);
      toastStore.push({ variant: "clean-merge", message: "Vault reconnected. Editing re-enabled." });
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

  onMount(async () => {
    // Subscribe to file-change events for merge logic (SYNC-01)
    unlistenFileChange = await listenFileChange(handleExternalFileChange);
    // Subscribe to vault status events for ERR-03 handling
    unlistenVaultStatus = await listenVaultStatus(handleVaultStatus);
  });

  onDestroy(() => {
    unsubTab();
    unsubVault();
    unlistenFileChange?.();
    unlistenVaultStatus?.();
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
  <div class="vc-editor-content" bind:this={contentEl}>
    {#if paneTabs.length === 0}
      <!-- Empty pane state -->
      <div class="vc-editor-empty">
        <p class="vc-editor-empty-heading">No file open</p>
        <p class="vc-editor-empty-body">Select a file from the sidebar, or drag a tab here to split the view.</p>
      </div>
    {/if}
    <!-- EditorView DOM containers are inserted here by createEditorView() -->
  </div>

  <!-- ERR-03 readonly overlay — shown when vault is unreachable -->
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

  /* ERR-03 readonly overlay — covers the editor area when vault is unreachable.
     pointer-events: none so text is still readable (no interaction possible).
     auto-save is also disabled in JS (double protection per T-02-21). */
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
