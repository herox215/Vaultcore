<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import TabBar from "../Tabs/TabBar.svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import { tabStore } from "../../store/tabStore";
  import type { Tab } from "../../store/tabStore";
  import { vaultStore } from "../../store/vaultStore";
  import { editorStore } from "../../store/editorStore";
  import { activeViewStore } from "../../store/activeViewStore";
  import { readFile, writeFile, mergeExternalChange, getResolvedLinks, createFile, getFileHash } from "../../ipc/commands";
  import { isVaultError } from "../../types/errors";
  import { toastStore } from "../../store/toastStore";
  import { buildExtensions } from "./extensions";
  import CountStatusBar from "./CountStatusBar.svelte";
  import { countsStore } from "../../store/countsStore";
  import { computeCounts } from "../../lib/wordCount";
  import { scrollToMatch } from "./flashHighlight";
  import { scrollStore } from "../../store/scrollStore";
  import { treeRefreshStore } from "../../store/treeRefreshStore";
  import { tabReloadStore } from "../../store/tabReloadStore";
  import { setResolvedLinks, resolveTarget, refreshWikiLinks } from "./wikiLink";
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

  // EDIT-10: Mirror editorStore.lastSavedHash for synchronous access inside onSave.
  // Cannot call get(editorStore) from inside a setTimeout callback safely in Svelte 5,
  // so we track it via subscribe (D-06/RC-01 classic writable store pattern).
  let lastSavedHashSnapshot: string | null = null;
  const unsubEditorHash = editorStore.subscribe((s) => {
    lastSavedHashSnapshot = s.lastSavedHash;
  });

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

  // Active tab file path for this pane — drives the breadcrumb bar.
  // Null when no tab is open in the pane, which hides the bar (AC-06).
  const paneActiveFilePath = $derived(
    paneActiveTabId !== null
      ? (paneTabs.find((t) => t.id === paneActiveTabId)?.filePath ?? null)
      : null
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

  // ─── Wiki-link resolution map ──────────────────────────────────────────────

  /**
   * Reload the stem->relPath resolution map from the Rust backend.
   * Called on vault open and after click-to-create so the new file resolves.
   */
  async function reloadResolvedLinks(): Promise<void> {
    try {
      const map = await getResolvedLinks();
      setResolvedLinks(map);
      // Refresh decorations on all mounted views in this pane
      for (const view of viewMap.values()) {
        refreshWikiLinks(view);
      }
    } catch {
      // Soft-fail: all links render as unresolved until next reload
      setResolvedLinks(new Map());
    }
  }

  /**
   * Handle wiki-link-click CustomEvent dispatched by the CM6 wikiLink plugin.
   * Resolved clicks open the target in a tab (zero IPC at click time).
   * Unresolved clicks create the note, open it, and refresh the resolution map.
   */
  function handleWikiLinkClick(event: Event): void {
    const detail = (event as CustomEvent).detail as { target: string; resolved: boolean };
    let vault: string | null = null;
    const u = vaultStore.subscribe((s) => { vault = s.currentPath; });
    u();
    if (!vault) return;

    if (detail.resolved) {
      // LINK-03: synchronous lookup — zero IPC at click time
      const relPath = resolveTarget(detail.target);
      if (!relPath) {
        // Map out of sync (rare: file deleted between decoration and click)
        void reloadResolvedLinks();
        return;
      }
      tabStore.openTab(`${vault}/${relPath}`);
    } else {
      // LINK-04, D-08: click-to-create at vault root
      const filename = detail.target.endsWith(".md")
        ? detail.target
        : `${detail.target}.md`;
      const vaultPath = vault as string;
      createFile(vaultPath, filename)
        .then(async (newAbsPath) => {
          tabStore.openTab(newAbsPath);
          // Refresh map so the new file now resolves in future decorations
          await reloadResolvedLinks();
          // Signal sidebar to re-fetch its tree — the watcher suppresses
          // backend-initiated writes via write_ignore, so the tree won't
          // otherwise learn that this file exists.
          treeRefreshStore.requestRefresh();
        })
        .catch(() =>
          toastStore.push({
            variant: "error",
            message: "Notiz konnte nicht erstellt werden.",
          })
        );
    }
  }

  // Track vault open transitions to reload the resolution map
  let prevVaultPath: string | null = null;
  const unsubVaultPath = vaultStore.subscribe((state) => {
    if (state.currentPath !== prevVaultPath) {
      prevVaultPath = state.currentPath;
      if (state.currentPath) {
        void reloadResolvedLinks();
      }
    }
  });

  // Subscribe to tabReloadStore — reload CM6 doc content when backend externally
  // rewrites files (e.g. rename-cascade). Matches tabs in THIS pane only by
  // absolute path (vault + rel path) and dispatches a replaceAll doc transaction.
  // Without this, after a cascade the open tab keeps showing the stale content
  // and the next auto-save would silently revert the cascade's rewrites.
  let prevReloadToken: string | null = null;
  const unsubTabReload = tabReloadStore.subscribe((state) => {
    if (!state.pending) return;
    if (state.pending.token === prevReloadToken) return;
    prevReloadToken = state.pending.token;

    let vault: string | null = null;
    const u = vaultStore.subscribe((s) => { vault = s.currentPath; });
    u();
    if (!vault) return;
    const vaultPath = vault as string;

    for (const relPath of state.pending.paths) {
      const absPath = `${vaultPath}/${relPath}`;
      const tab = allTabs.find((t) => t.filePath === absPath && paneTabIds.includes(t.id));
      if (!tab) continue;
      const view = viewMap.get(tab.id);
      if (!view) continue;
      // Re-read file from disk and replace the entire document. No merge needed
      // here — the user just confirmed the cascade, they're not actively editing.
      void readFile(absPath).then((content) => {
        if (!view) return;
        const currentLen = view.state.doc.length;
        view.dispatch({
          changes: { from: 0, to: currentLen, insert: content },
        });
      }).catch(() => { /* file vanished — leave tab alone */ });
    }
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
          if (activePane === paneId) {
            activeViewStore.setActive(activeView);
          }
        }
      } else if (activePane === paneId) {
        activeViewStore.setActive(null);
      }
      prevActiveTabId = newActiveId;
    }
  });

  // Republish counts for THIS pane whenever the active tab changes. Each
  // view has its own countsPlugin instance, but because they all write to
  // the same paneId slot, a tab switch alone doesn't re-trigger publication
  // on the newly-active view. Publish directly from the shared `computeCounts`
  // helper so the status bar updates immediately on switch.
  $effect(() => {
    const activeId = paneActiveTabId;
    if (!activeId) {
      countsStore.clear(paneId);
      return;
    }
    const view = viewMap.get(activeId);
    if (!view) return;
    const sel = view.state.selection.main;
    const text = sel.empty
      ? view.state.doc.toString()
      : view.state.sliceDoc(sel.from, sel.to);
    const { words, characters } = computeCounts(text);
    countsStore.set(paneId, { words, characters, selection: !sel.empty });
  });

  // Also publish the active view whenever the active pane itself switches.
  // The block above only fires on tab-id changes within this pane — moving
  // focus between panes wouldn't otherwise update the sidebar's source view.
  $effect(() => {
    if (activePane !== paneId) return;
    const id = paneActiveTabId;
    if (!id) {
      activeViewStore.setActive(null);
      return;
    }
    const view = viewMap.get(id);
    if (view) activeViewStore.setActive(view);
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

    // Find the container div rendered by Svelte's {#each} block.
    // Scope to this pane's DOM element — document.querySelector would match
    // the first .vc-editor-pane in the DOM, breaking right-pane mounts.
    const container = paneEl?.querySelector(
      `[data-tab-id="${tab.id}"]`
    ) as HTMLDivElement | null;
    if (!container) return; // tab was closed before async completed

    // Guard against double-mount (async race)
    if (viewMap.has(tab.id)) return;

    // Initialize lastSavedContent snapshot for three-way merge base
    tabStore.setLastSavedContent(tab.id, content);

    const onSave = async (text: string): Promise<void> => {
      // ERR-03: skip auto-save when vault is unreachable
      if (!vaultReachable) return;

      try {
        // EDIT-10: Hash-verify branch — detect external modifications before writing.
        let diskHash: string | null;
        try {
          diskHash = await getFileHash(tab.filePath);
        } catch (e) {
          // FileNotFound means the file was deleted externally → fall through to
          // write (create path). Any other error re-throws via existing toast plumbing.
          if (isVaultError(e) && e.kind === "FileNotFound") {
            diskHash = null;
          } else {
            throw e;
          }
        }

        // Snapshot the expected hash (what VaultCore last wrote / first read).
        const expected = lastSavedHashSnapshot;

        if (diskHash !== null && expected !== null && diskHash !== expected) {
          // MISMATCH: external edit detected — route through three-way merge engine.
          const baseContent = tab.lastSavedContent;
          const result = await mergeExternalChange(tab.filePath, text, baseContent);

          // Apply merged content back to the CM6 view for this tab.
          const view = viewMap.get(tab.id);
          if (view) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: result.merged_content },
            });
          }

          // Write the merged content to disk so hash converges.
          const newHash = await writeFile(tab.filePath, result.merged_content);
          editorStore.setLastSavedHash(newHash);
          tabStore.setLastSavedContent(tab.id, result.merged_content);
          tabStore.setDirty(tab.id, false);

          // Toasts — reuse the exact Phase 2 German strings.
          const filename = tab.filePath.split("/").pop() ?? tab.filePath;
          if (result.outcome === "clean") {
            toastStore.push({ variant: "clean-merge", message: "Externe Änderungen wurden eingebunden" });
          } else {
            toastStore.push({ variant: "conflict", message: `Konflikt in ${filename} – lokale Version behalten` });
          }
          return;
        }

        // Hashes match (or file missing → create-path) — safe to write directly.
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

    const extensions = buildExtensions(onSave, paneId);
    const { EditorView: EV } = await import("@codemirror/view");
    const dirtyListener = EV.updateListener.of((update) => {
      if (update.docChanged) {
        onDirty();
      }
    });

    // Final guard — tab may have been closed during second await
    if (!paneEl?.querySelector(`[data-tab-id="${tab.id}"]`)) return;
    if (viewMap.has(tab.id)) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [...extensions, dirtyListener],
      }),
      parent: container,
    });

    viewMap.set(tab.id, view);

    // Attach wiki-link-click listener to the CM6 DOM
    view.dom.addEventListener("wiki-link-click", handleWikiLinkClick);

    // Sync editorStore if this is the active tab
    if (tab.id === paneActiveTabId) {
      editorStore.syncFromTab(tab.filePath, content, null);
      if (activePane === paneId) {
        activeViewStore.setActive(view);
      }
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
    // Populate the resolution map once when the pane first mounts
    // (vault may already be open from a prior navigation)
    void reloadResolvedLinks();
  });

  onDestroy(() => {
    unsubTab();
    unsubVault();
    unsubScroll();
    unsubTabReload();
    unsubVaultPath();
    unsubEditorHash();
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

  <!-- Breadcrumb path bar — self-hides when no tab is open (AC-06). -->
  <Breadcrumbs filePath={paneActiveFilePath} />

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

  {#if paneTabs.length > 0}
    <CountStatusBar {paneId} />
  {/if}

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
