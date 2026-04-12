<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import TabBar from "../Tabs/TabBar.svelte";
  import { tabStore } from "../../store/tabStore";
  import type { Tab } from "../../store/tabStore";
  import { vaultStore } from "../../store/vaultStore";
  import { editorStore } from "../../store/editorStore";
  import { readFile, writeFile, mergeExternalChange } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import { buildExtensions } from "./extensions";
  import { scrollToMatch } from "./flashHighlight";
  import { scrollStore } from "../../store/scrollStore";
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
  const viewMap = new Map<string, EditorView>();

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

  // Drag-to-split visual state
  let splitIndicatorSide = $state<"left" | "right" | null>(null);

  // ERR-04: Disk-full toast debounce — max one toast per 30 seconds
  let lastDiskFullToast = 0;
  const DISK_FULL_DEBOUNCE_MS = 30_000;

  // Track the previously active tab for scroll save/restore
  let prevActiveTabId: string | null = null;

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

  // Subscribe to tabStore for our pane's tabs and active state
  const unsubTab = tabStore.subscribe((state) => {
    paneTabIds = state.splitState[paneId];
    allTabs = state.tabs;
    activeTabId = state.activeTabId;
    activePane = state.splitState.activePane;
  });

  // Subscribe to vaultStore for vault reachability (ERR-03)
  const unsubVault = vaultStore.subscribe((state) => {
    vaultReachable = state.vaultReachable;
  });

  // Subscribe to scrollStore — execute scroll-to-match when a request targets a file in this pane.
  // Uses doc.toString().indexOf() to find the first occurrence (no @codemirror/search dep needed).
  const unsubScroll = scrollStore.subscribe((state) => {
    if (!state.pending) return;
    const { filePath, searchText } = state.pending;
    // Find which tab in this pane has this file
    const tab = allTabs.find((t) => t.filePath === filePath && paneTabIds.includes(t.id));
    if (!tab) return;
    const view = viewMap.get(tab.id);
    if (!view) return;
    // Find first occurrence of searchText using plain string search (case-insensitive)
    const docText = view.state.doc.toString();
    const lowerDoc = docText.toLowerCase();
    const lowerSearch = searchText.toLowerCase();
    const from = lowerDoc.indexOf(lowerSearch);
    if (from === -1) return;
    const to = from + searchText.length;
    scrollToMatch(view, from, to);
    scrollStore.clearPending();
  });

  // Manage EditorView lifecycle — create views for new tabs, destroy for removed
  $effect(() => {
    const currentIds = new Set(paneTabIds);

    // Remove views for tabs no longer in this pane
    for (const [id, view] of viewMap) {
      if (!currentIds.has(id)) {
        view.destroy();
        viewMap.delete(id);
      }
    }

    // Create views for new tabs (async — the container div is already in the DOM
    // via the Svelte template, so we just need to mount the EditorView into it)
    for (const tabId of paneTabIds) {
      if (!viewMap.has(tabId)) {
        const tab = allTabs.find((t) => t.id === tabId);
        if (tab) {
          mountEditorView(tab);
        }
      }
    }
  });

  // Handle scroll save/restore on tab switch — separate effect to avoid
  // coupling with the lifecycle effect above
  $effect(() => {
    const newActiveId = paneActiveTabId;
    if (newActiveId !== prevActiveTabId) {
      // Save scroll/cursor on deactivated tab
      if (prevActiveTabId) {
        const prevView = viewMap.get(prevActiveTabId);
        if (prevView) {
          try {
            tabStore.updateScrollPos(
              prevActiveTabId,
              prevView.scrollDOM.scrollTop,
              prevView.state.selection.main.head
            );
          } catch (_) { /* view may have been destroyed */ }
        }
      }
      // Restore scroll/cursor on activated tab
      if (newActiveId) {
        const activeView = viewMap.get(newActiveId);
        const activeTab = allTabs.find((t) => t.id === newActiveId);
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
      prevActiveTabId = newActiveId;
    }
  });

  /**
   * Mount an EditorView into the container div rendered by Svelte's template.
   * The container is found via data-tab-id attribute in the DOM.
   */
  async function mountEditorView(tab: Tab) {
    if (viewMap.has(tab.id)) return;

    let content = "";
    try {
      content = await readFile(tab.filePath);
    } catch (err) {
      toastStore.push({ variant: "error", message: `Failed to open file.` });
      return;
    }

    // Find the container div rendered by Svelte's {#each} block
    const container = document.querySelector(
      `.vc-editor-pane [data-tab-id="${tab.id}"]`
    ) as HTMLDivElement | null;
    if (!container) return; // tab was closed before async completed

    // Guard against double-mount (async race)
    if (viewMap.has(tab.id)) return;

    // Initialize lastSavedContent snapshot for three-way merge base
    tabStore.setLastSavedContent(tab.id, content);

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
          tabStore.setDirty(tab.id, true);
        } else {
          toastStore.push({ variant: "error", message: "Disk full. Could not save changes." });
        }
      }
    };

    const onDirty = () => {
      tabStore.setDirty(tab.id, true);
    };

    const extensions = buildExtensions(onSave);
    const { EditorView: EV } = await import("@codemirror/view");
    const dirtyListener = EV.updateListener.of((update) => {
      if (update.docChanged) {
        onDirty();
      }
    });

    // Final guard — tab may have been closed during second await
    if (!document.querySelector(`.vc-editor-pane [data-tab-id="${tab.id}"]`)) return;
    if (viewMap.has(tab.id)) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [...extensions, dirtyListener],
      }),
      parent: container,
    });

    viewMap.set(tab.id, view);

    // Sync editorStore if this is the active tab
    if (tab.id === paneActiveTabId) {
      editorStore.syncFromTab(tab.filePath, content, null);
    }
  }

  // ─── Watcher event handling ────────────────────────────────────────────────

  async function handleExternalFileChange(payload: FileChangePayload) {
    const { path, kind, new_path } = payload;

    if (kind === "modify") {
      const tabWithPath = allTabs.find((t) => t.filePath === path && paneTabIds.includes(t.id));
      if (!tabWithPath || !viewMap.has(tabWithPath.id)) return;

      const view = viewMap.get(tabWithPath.id)!;
      const editorContent = view.state.doc.toString();
      const lastSavedContent = tabWithPath.lastSavedContent;
      const filename = path.split("/").pop() ?? path;

      try {
        const result = await mergeExternalChange(path, editorContent, lastSavedContent);

        if (result.outcome === "clean") {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: result.merged_content },
          });
          tabStore.setLastSavedContent(tabWithPath.id, result.merged_content);
          toastStore.push({
            variant: "clean-merge",
            message: `Externe Änderungen wurden in ${filename} eingebunden.`,
          });
        } else {
          tabStore.setLastSavedContent(tabWithPath.id, editorContent);
          toastStore.push({
            variant: "conflict",
            message: `Konflikt in ${filename} – lokale Version behalten.`,
          });
        }
      } catch (_err) {
        // silently ignore — delete event handles cleanup
      }
    } else if (kind === "delete") {
      const tabWithPath = allTabs.find((t) => t.filePath === path && paneTabIds.includes(t.id));
      if (tabWithPath) {
        const view = viewMap.get(tabWithPath.id);
        if (view) {
          view.destroy();
          viewMap.delete(tabWithPath.id);
        }
      }
    } else if (kind === "rename" && new_path) {
      // viewMap is keyed by tabId, not filePath — no rekeying needed
    }
  }

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
    unlistenFileChange = await listenFileChange(handleExternalFileChange);
    unlistenVaultStatus = await listenVaultStatus(handleVaultStatus);
  });

  onDestroy(() => {
    unsubTab();
    unsubVault();
    unsubScroll();
    unlistenFileChange?.();
    unlistenVaultStatus?.();
    for (const view of viewMap.values()) {
      view.destroy();
    }
    viewMap.clear();
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

  <!-- Editor content area -->
  <div class="vc-editor-content">
    {#if paneTabs.length === 0}
      <div class="vc-editor-empty">
        <p class="vc-editor-empty-heading">No file open</p>
        <p class="vc-editor-empty-body">Select a file from the sidebar, or drag a tab here to split the view.</p>
      </div>
    {/if}
    <!-- Svelte renders one container per tab. Visibility is driven by
         style:display reacting to paneActiveTabId — no manual DOM needed. -->
    {#each paneTabs as tab (tab.id)}
      <div
        class="vc-editor-container"
        data-tab-id={tab.id}
        style:display={tab.id === paneActiveTabId ? "block" : "none"}
      ></div>
    {/each}
  </div>

  {#if !vaultReachable}
    <div class="vc-editor-readonly-overlay"></div>
  {/if}

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

  .vc-editor-container {
    position: absolute;
    inset: 0;
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

  .vc-editor-readonly-overlay {
    pointer-events: none;
    background: rgba(255, 255, 255, 0.6);
    position: absolute;
    inset: 0;
    z-index: 10;
  }

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
