<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { EditorView } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import TabBar from "../Tabs/TabBar.svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import GraphView from "../Graph/GraphView.svelte";
  import ImagePreview from "./ImagePreview.svelte";
  import UnsupportedPreview from "./UnsupportedPreview.svelte";
  import CanvasView from "../Canvas/CanvasView.svelte";
  import ReadingView from "./ReadingView.svelte";
  import { tabStore } from "../../store/tabStore";
  import type { Tab } from "../../store/tabStore";
  import { vaultStore } from "../../store/vaultStore";
  import { editorStore } from "../../store/editorStore";
  import { activeViewStore } from "../../store/activeViewStore";
  import { readFile, writeFile, mergeExternalChange, getResolvedLinks, getResolvedAnchors, getResolvedAttachments, createFile, getFileHash } from "../../ipc/commands";
  import { openFileAsTab } from "../../lib/openFileAsTab";
  import { isVaultError } from "../../types/errors";
  import { toastStore } from "../../store/toastStore";
  import { searchStore } from "../../store/searchStore";
  import { buildExtensions, buildReadOnlyExtensions } from "./extensions";
  import { insertTemplateExpression } from "./editorContextMenu";
  import TemplateExpressionBuilder from "./TemplateExpressionBuilder.svelte";
  import ContextMenu from "../common/ContextMenu.svelte";
  import { parseFrontmatter } from "../../lib/frontmatterIO";
  import EditorGraphBackground from "./EditorGraphBackground.svelte";
  import CountStatusBar from "./CountStatusBar.svelte";
  import TabMorphOverlay from "./TabMorphOverlay.svelte";
  import { countsStore } from "../../store/countsStore";
  import { computeCounts } from "../../lib/wordCount";
  import { scrollToMatch } from "./flashHighlight";
  import { scrollStore } from "../../store/scrollStore";
  import { treeRefreshStore } from "../../store/treeRefreshStore";
  import { resolvedLinksStore } from "../../store/resolvedLinksStore";
  import { tagsStore } from "../../store/tagsStore";
  import { tabReloadStore } from "../../store/tabReloadStore";
  import {
    setResolvedAnchors,
    setResolvedLinks,
    resolveAnchor,
    resolveTarget,
    refreshWikiLinks,
    type WikiLinkClickDetail,
  } from "./wikiLink";
  import { setResolvedAttachments } from "./embeds";
  import { decideExternalModifyAction, sha256Hex } from "./externalChangeHandler";
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

  // #90: Track tab IDs currently being mounted (readFile in-flight).
  // Prevents duplicate concurrent mountEditorView calls when the
  // mount-lifecycle $effect re-fires while a mount is already in progress.
  const mountingIds = new Set<string>();

  // Local reactive state driven by store subscription
  let paneTabIds = $state<string[]>([]);
  let allTabs = $state<Tab[]>([]);
  let activeTabId = $state<string | null>(null);
  let activePane = $state<"left" | "right">("left");
  // ERR-03: vault reachability — driven by vaultStore.vaultReachable
  let vaultReachable = $state(true);
  let currentVaultPath = $state<string | null>(null);

  // Watcher event unlisten handles
  let unlistenFileChange: UnlistenFn | null = null;
  let unlistenVaultStatus: UnlistenFn | null = null;

  // Pane host element — used by container-querying helpers below.
  let paneEl = $state<HTMLDivElement | undefined>();

  // Custom editor context-menu (#301). The active CM6 `EditorView` target is
  // stored in a non-reactive ref because Svelte 5 would otherwise proxy the
  // object and break CM6's internal field access (same pitfall as viewMap).
  let contextView: EditorView | null = null;
  let contextMenuOpen = $state(false);
  let contextMenuPos = $state({ x: 0, y: 0 });
  let templateBuilderOpen = $state(false);
  let templateBuilderKeys = $state<string[]>([]);

  function handleContextMenuRequest(view: EditorView, x: number, y: number) {
    contextView = view;
    contextMenuPos = { x, y };
    contextMenuOpen = true;
  }

  function closeContextMenu() {
    contextMenuOpen = false;
  }

  function readActiveSelection(): string {
    if (!contextView) return "";
    const sel = contextView.state.selection.main;
    return contextView.state.sliceDoc(sel.from, sel.to);
  }

  function menuAction_copy() {
    const text = readActiveSelection();
    closeContextMenu();
    if (!text) return;
    void navigator.clipboard.writeText(text).catch(() => { /* blocked — no-op */ });
  }

  function menuAction_cut() {
    if (!contextView) { closeContextMenu(); return; }
    const view = contextView;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    closeContextMenu();
    if (!text) return;
    void navigator.clipboard.writeText(text).catch(() => { /* blocked */ });
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "" },
      userEvent: "delete.cut",
    });
  }

  async function menuAction_paste() {
    if (!contextView) { closeContextMenu(); return; }
    const view = contextView;
    const sel = view.state.selection.main;
    closeContextMenu();
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return; // clipboard blocked (e.g. no permission); user can still Ctrl+V.
    }
    if (!text) return;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      userEvent: "input.paste",
    });
  }

  function menuAction_selectAll() {
    if (!contextView) { closeContextMenu(); return; }
    const view = contextView;
    const len = view.state.doc.length;
    closeContextMenu();
    view.dispatch({ selection: { anchor: 0, head: len } });
  }

  function menuAction_openBuilder() {
    if (!contextView) { closeContextMenu(); return; }
    // Surface frontmatter keys from the active doc so the lambda's property
    // picker can offer `n.property.<key>` without requiring free-text.
    const docText = contextView.state.doc.toString();
    try {
      const { properties } = parseFrontmatter(docText);
      templateBuilderKeys = properties.map((p) => p.key);
    } catch {
      templateBuilderKeys = [];
    }
    contextMenuOpen = false;
    templateBuilderOpen = true;
  }

  function onBuilderInsert(dsl: string) {
    if (contextView) insertTemplateExpression(contextView, dsl);
    templateBuilderOpen = false;
    contextView = null;
  }

  function onBuilderCancel() {
    templateBuilderOpen = false;
    contextView = null;
  }

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
  // Track prior viewMode per tab so we can save/restore scroll on mode switches (#63).
  const prevViewMode = new Map<string, "edit" | "read">();

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
  // Graph tabs have no on-disk path and should hide the breadcrumb.
  const paneActiveFilePath = $derived.by<string | null>(() => {
    if (paneActiveTabId === null) return null;
    const t = paneTabs.find((x) => x.id === paneActiveTabId);
    if (!t) return null;
    if (t.type === "graph") return null;
    return t.filePath;
  });

  // #63: active tab of this pane, exposed so Breadcrumbs can drive its
  // Reading Mode toggle. Non-markdown / graph tabs get `undefined` so the
  // toggle is hidden for tab kinds that don't support Reading Mode.
  const paneActiveTab = $derived<Tab | null>(
    paneActiveTabId !== null ? paneTabs.find((t) => t.id === paneActiveTabId) ?? null : null,
  );
  const paneActiveTabSupportsReading = $derived(
    paneActiveTab !== null &&
    paneActiveTab.type !== "graph" &&
    paneActiveTab.viewer !== "image" &&
    paneActiveTab.viewer !== "unsupported" &&
    paneActiveTab.viewer !== "text",
  );

  // #87: show ambient local-graph background in edit mode on markdown tabs.
  const showGraphBg = $derived(
    paneActiveTabSupportsReading &&
    paneActiveTab !== null &&
    (paneActiveTab.viewMode ?? "edit") === "edit"
  );
  const bgRelPath = $derived.by<string | null>(() => {
    if (!showGraphBg || !paneActiveTab || !currentVaultPath) return null;
    if (paneActiveTab.filePath.startsWith(currentVaultPath + "/")) {
      return paneActiveTab.filePath.slice(currentVaultPath.length + 1);
    }
    return null;
  });

  // #49: tabs whose viewer is not "markdown"/"text" don't host a CM6 view.
  // Used to skip the editor-mount loop and to gate the count status bar.
  function tabHasEditor(t: Tab | undefined): boolean {
    if (!t) return false;
    if (t.type === "graph") return false;
    if (t.viewer === "image" || t.viewer === "unsupported") return false;
    if (t.viewer === "canvas") return false;
    return true;
  }

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
    currentVaultPath = state.currentPath;
  });

  // ─── Wiki-link resolution map ──────────────────────────────────────────────

  /**
   * Reload the stem->relPath resolution maps from the Rust backend. Handles
   * both wiki-link and attachment resolution so the embed plugin (issue #9)
   * can resolve `![[image.png]]` synchronously. Each call fires two IPC
   * requests in parallel and then nudges every mounted view to rebuild
   * decorations — `refreshWikiLinks` dispatches an empty transaction which
   * picks up both the wiki-link plugin and the embed plugin at once.
   */
  async function reloadResolvedLinks(): Promise<void> {
    try {
      const [linksMap, anchorsMap, attachmentsMap] = await Promise.all([
        getResolvedLinks(),
        getResolvedAnchors(),
        getResolvedAttachments(),
      ]);
      setResolvedLinks(linksMap);
      setResolvedAnchors(anchorsMap);
      setResolvedAttachments(attachmentsMap);
      for (const view of viewMap.values()) {
        refreshWikiLinks(view);
      }
    } catch {
      // Soft-fail: all links/embeds render as unresolved until next reload
      setResolvedLinks(new Map());
      setResolvedAnchors(new Map());
      setResolvedAttachments(new Map());
    }
    // #309 — bump readyToken AFTER the map has been swapped in (success or
    // soft-fail) so decoration layers that outlive EditorPane's refresh — CM6
    // template live-preview, Reading Mode — can rebuild against the fresh
    // map. Without this, their subscriptions would either never fire or fire
    // on requestToken and rebuild against the still-stale map.
    resolvedLinksStore.markReady();
  }

  /**
   * Handle wiki-link-click CustomEvent dispatched by the CM6 wikiLink plugin.
   *
   * Three resolution paths (#62):
   *   - "resolved"       — open the target tab; if an anchor is attached,
   *                        scroll to the anchor's `[jsStart, jsEnd)` range.
   *   - "anchor-missing" — open the target tab and surface a warning toast;
   *                        do not scroll (no usable target range).
   *   - "unresolved"     — click-to-create at vault root, same as before.
   *
   * Even on "resolved" we re-check the live map (#309) so a stale decoration
   * doesn't route a now-broken link into the wrong branch.
   */
  function handleWikiLinkClick(event: Event): void {
    const detail = (event as CustomEvent<WikiLinkClickDetail>).detail;
    const vault = get(vaultStore).currentPath;
    if (!vault) return;

    // #309 kept verbatim: re-check the live map so a stale decoration
    // (`resolved` baked in at decoration time, file came/went between then
    // and click) doesn't route the wrong way.
    const liveRelPath = resolveTarget(detail.target);

    if (liveRelPath) {
      const relPath = liveRelPath;
      const absPath = `${vault}/${relPath}`;
      if (relPath.endsWith(".canvas")) {
        tabStore.openFileTab(absPath, "canvas");
        return;
      }
      tabStore.openTab(absPath);
      if (detail.anchor) {
        // #62: prefer a fresh anchor lookup over the decoration-time
        // `resolution` so an anchor newly indexed between render and click
        // navigates correctly instead of toasting "not found".
        const entry = resolveAnchor(relPath, detail.anchor);
        if (entry) {
          // Same store the OmniSearch flow uses — pane-agnostic routing keeps
          // anchor scrolls working when the target tab opens in the other
          // pane. Range may also fire before the view is mounted; the
          // subscriber clamps to doc length and the request stays pending
          // until consumed.
          scrollStore.requestScrollToRange(absPath, entry.jsStart, entry.jsEnd);
        } else {
          const anchorLabel =
            detail.anchor.kind === "block" ? `^${detail.anchor.value}` : `#${detail.anchor.value}`;
          toastStore.push({
            variant: "warning",
            message: `Anker ${anchorLabel} in ${relPath} nicht gefunden`,
          });
        }
      }
      return;
    }

    // No live entry. If the decoration thought the target resolved (or had
    // an anchor on a now-missing note), short-circuit into a reload — the
    // map is stale, not the user's intent.
    if (detail.resolution === "resolved" || detail.resolution === "anchor-missing") {
      void reloadResolvedLinks();
      return;
    }

    // Truly unresolved — click-to-create at vault root.
    const filename = detail.target.endsWith(".md")
      ? detail.target
      : `${detail.target}.md`;
    const vaultPath = vault as string;
    createFile(vaultPath, filename)
      .then(async (newAbsPath) => {
        tabStore.openTab(newAbsPath);
        await reloadResolvedLinks();
        treeRefreshStore.requestRefresh();
      })
      .catch(() =>
        toastStore.push({
          variant: "error",
          message: "Notiz konnte nicht erstellt werden.",
        })
      );
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

  // #277: user-initiated rename/move bypass the watcher (write_ignore), so the
  // module-level `resolvedLinks` map in wikiLink.ts keeps the stale OLD
  // rel_path until a manual reload. TreeNode fires `resolvedLinksStore.requestReload()`
  // after every rename/move so we refresh here and the click handler stops
  // routing [[new-name]] into the create-at-root fallback.
  let prevResolvedLinksRequestToken: string | null = null;
  const unsubResolvedLinks = resolvedLinksStore.subscribe((state) => {
    if (
      state.requestToken &&
      state.requestToken !== prevResolvedLinksRequestToken
    ) {
      prevResolvedLinksRequestToken = state.requestToken;
      void reloadResolvedLinks();
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

    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;

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
  // Two paths: an explicit `range` (anchor navigation #62) wins; otherwise
  // fall back to the legacy string search OmniSearch uses.
  const unsubScroll = scrollStore.subscribe((state) => {
    if (!state.pending) return;
    const { filePath, searchText, range } = state.pending;
    const tab = allTabs.find((t) => t.filePath === filePath && paneTabIds.includes(t.id));
    if (!tab) return;
    const view = viewMap.get(tab.id);
    if (!view) return;
    if (range) {
      // Clamp to current document length — the anchor index can lag a hot
      // edit by one save cycle, and a stale range past EOF would crash CM6.
      const docLen = view.state.doc.length;
      const from = Math.min(range.from, docLen);
      const to = Math.min(range.to, docLen);
      if (from < to) scrollToMatch(view, from, to);
      scrollStore.clearPending();
      return;
    }
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
    // via the Svelte template, so we just need to mount the EditorView into it).
    // Graph tabs are rendered via <GraphView /> and must NOT get a CM6 view.
    // Image / unsupported preview tabs render their own components and skip CM6.
    for (const tabId of paneTabIds) {
      if (!viewMap.has(tabId) && !mountingIds.has(tabId)) {
        const tab = allTabs.find((t) => t.id === tabId);
        if (tab && tabHasEditor(tab)) {
          // Snapshot the tab as a plain object so the async mount function
          // is not affected by reactive proxy shifts when allTabs is
          // reassigned by the store subscription mid-mount (#88).
          mountEditorView({ ...tab });
        }
      }
    }
  });

  // #63: Persist the editor's scroll position when a tab switches from
  // edit → read so switching back restores it. Reading Mode tracks its own
  // readingScrollPos on its side.
  $effect(() => {
    for (const tab of paneTabs) {
      const mode: "edit" | "read" = tab.viewMode ?? "edit";
      const previous = prevViewMode.get(tab.id);
      if (previous !== undefined && previous !== mode) {
        if (previous === "edit" && mode === "read") {
          const view = viewMap.get(tab.id);
          if (view) {
            try {
              tabStore.updateScrollPos(
                tab.id,
                view.scrollDOM.scrollTop,
                view.state.selection.main.head,
              );
            } catch (_) { /* view torn down */ }
          }
        } else if (previous === "read" && mode === "edit") {
          const view = viewMap.get(tab.id);
          if (view) {
            const pos = Math.min(tab.cursorPos, view.state.doc.length);
            if (pos > 0) {
              view.dispatch({ selection: { anchor: pos } });
            }
            requestAnimationFrame(() => {
              view.scrollDOM.scrollTop = tab.scrollPos;
            });
          }
        }
      }
      prevViewMode.set(tab.id, mode);
    }
    for (const id of prevViewMode.keys()) {
      if (!paneTabIds.includes(id)) prevViewMode.delete(id);
    }
  });

  // #380: handle to the per-pane morph overlay. The overlay is mounted
  // inside .vc-editor-content (so it sits above the editor containers
  // but below the read-only scrim) and runs a 120ms canvas scramble on
  // qualifying tab switches.
  let morphOverlay: { play: (out: EditorView | null, inc: EditorView | null) => void } | null = $state(null);

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
      // #380: trigger morph if both sides are already-mounted text editors.
      // Skipped during async mount (mountingIds), for non-editor tabs
      // (graph/image/canvas/unsupported), and when either side is in
      // Reading Mode (no CM6 layout to snapshot).
      if (
        prevActiveTabId &&
        newActiveId &&
        morphOverlay &&
        !mountingIds.has(newActiveId)
      ) {
        const outTab = allTabs.find((t) => t.id === prevActiveTabId);
        const inTab = allTabs.find((t) => t.id === newActiveId);
        const outView = viewMap.get(prevActiveTabId);
        const inView = viewMap.get(newActiveId);
        const bothEdit =
          (outTab?.viewMode ?? "edit") === "edit" &&
          (inTab?.viewMode ?? "edit") === "edit";
        if (
          outView &&
          inView &&
          bothEdit &&
          tabHasEditor(outTab) &&
          tabHasEditor(inTab)
        ) {
          morphOverlay.play(outView, inView);
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
            activeTab.lastSavedHash ?? null,
          );
          if (activePane === paneId) {
            activeViewStore.setActive(activeView);
          }
        } else if (activePane === paneId) {
          // #49: image / unsupported / graph tabs have no CM6 view — clear
          // the active view so sidebar panels that depend on the CM6 source
          // don't keep pointing at the previously-active editor.
          activeViewStore.setActive(null);
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
    const activeTab = allTabs.find((t) => t.id === activeId);
    // #49: image / unsupported preview tabs have no CM6 view and no
    // meaningful character count — clear the status bar slot.
    if (!tabHasEditor(activeTab)) {
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
    // #49: viewMap has no entry for image / unsupported preview tabs, so
    // null out the active view — sidebar panels driven by it (backlinks,
    // outgoing links, properties) will empty their contents rather than
    // keep reflecting the previously-active markdown tab.
    activeViewStore.setActive(view ?? null);
  });

  /**
   * Mount an EditorView into the container div rendered by Svelte's template.
   * The container is found via data-tab-id attribute in the DOM.
   */
  async function mountEditorView(tab: Tab) {
    const id = tab.id;
    if (viewMap.has(id)) return;
    // #90: prevent duplicate concurrent mounts when the $effect re-fires
    // while readFile is still in-flight.
    if (mountingIds.has(id)) return;
    mountingIds.add(id);

    try {
      return await mountEditorViewInner(tab);
    } finally {
      mountingIds.delete(id);
    }
  }

  async function mountEditorViewInner(tab: Tab) {
    // Snapshot tab identity before the async boundary so the values are
    // stable even if the reactive proxy behind `tab` shifts when allTabs
    // is reassigned by the store subscription while readFile is
    // in-flight (#88).
    const tabId = tab.id;
    const tabFilePath = tab.filePath;

    let content = "";
    try {
      content = await readFile(tabFilePath);
    } catch (err) {
      const filename = tabFilePath.split("/").pop() ?? tabFilePath;
      toastStore.push({ variant: "error", message: `Failed to open ${filename}.` });
      return;
    }

    // Find the container div rendered by Svelte's {#each} block.
    // Scope to this pane's DOM element — document.querySelector would match
    // the first .vc-editor-pane in the DOM, breaking right-pane mounts.
    const container = paneEl?.querySelector(
      `[data-tab-id="${tabId}"]`
    ) as HTMLDivElement | null;
    if (!container) return; // tab was closed before async completed

    // Guard against double-mount (async race)
    if (viewMap.has(tabId)) return;

    const onSave = async (text: string): Promise<void> => {
      // ERR-03: skip auto-save when vault is unreachable
      if (!vaultReachable) return;

      // Read the current filePath from the store at save time rather than
      // using the mount-time capture (#89). When a file is renamed while
      // the editor is open, tabStore.updateFilePath updates the tab's
      // filePath but the closure's captured snapshot still holds the old
      // path.
      const currentTab = allTabs.find((t) => t.id === tabId);
      const filePath = currentTab?.filePath ?? tabFilePath;

      try {
        // EDIT-10: Hash-verify branch — detect external modifications before writing.
        let diskHash: string | null;
        try {
          diskHash = await getFileHash(filePath);
        } catch (e) {
          // FileNotFound means the file was deleted externally → fall through to
          // write (create path). Any other error re-throws via existing toast plumbing.
          if (isVaultError(e) && e.kind === "FileNotFound") {
            diskHash = null;
          } else {
            throw e;
          }
        }

        // Per-tab expected hash (#80). Reading the global editorStore snapshot
        // here leaked another tab's hash in when the user switched tabs mid-edit.
        const expected = allTabs.find((t) => t.id === tabId)?.lastSavedHash ?? null;

        if (diskHash !== null && expected !== null && diskHash !== expected) {
          // MISMATCH: external edit detected — route through three-way merge engine.
          // Issue #339: on clean, the backend writes the merged bytes to disk
          // itself and returns `new_hash`. We must NOT call writeFile here —
          // that would double-write and double-dispatch the index updates.
          const baseContent = currentTab?.lastSavedContent ?? "";
          const result = await mergeExternalChange(filePath, text, baseContent);

          // Apply merged content back to the CM6 view for this tab.
          const view = viewMap.get(tabId);
          if (view) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: result.merged_content },
            });
          }

          // On clean the backend just wrote; new_hash is the authoritative
          // next-disk-state. On conflict the backend did NOT write — hash
          // the merged (== local) content so the next autosave doesn't
          // re-enter merge against a stale expected hash.
          const newHash =
            result.outcome === "clean"
              ? result.new_hash
              : await sha256Hex(result.merged_content);
          editorStore.setLastSavedHash(newHash);
          tabStore.setLastSavedHash(tabId, newHash);
          tabStore.setLastSavedContent(tabId, result.merged_content);
          tabStore.setDirty(tabId, false);
          searchStore.setIndexStale(true);
          void tagsStore.reload();

          // Toasts — reuse the exact Phase 2 German strings.
          const filename = filePath.split("/").pop() ?? filePath;
          if (result.outcome === "clean") {
            toastStore.push({ variant: "clean-merge", message: "Externe Änderungen wurden eingebunden" });
          } else {
            toastStore.push({ variant: "conflict", message: `Konflikt in ${filename} – lokale Version behalten` });
          }
          return;
        }

        // Hashes match (or file missing → create-path) — safe to write directly.
        const hash = await writeFile(filePath, text);
        tabStore.setDirty(tabId, false);
        tabStore.setLastSavedContent(tabId, text);
        tabStore.setLastSavedHash(tabId, hash);
        editorStore.setLastSavedHash(hash);
        searchStore.setIndexStale(true);
        void tagsStore.reload();
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
          tabStore.setDirty(tabId, true);
        } else {
          toastStore.push({ variant: "error", message: "Disk full. Could not save changes." });
        }
      }
    };

    const onDirty = () => {
      tabStore.setDirty(tabId, true);
    };

    // #49: non-markdown text previews use the read-only extension list so
    // editing is disabled, autosave is stripped (no overwrite of .json/.csv),
    // and wiki-link / embed plugins are skipped.
    const isReadOnly = tab.viewer === "text";
    const extensions = isReadOnly
      ? buildReadOnlyExtensions()
      : buildExtensions(onSave, paneId, handleContextMenuRequest);
    const { EditorView: EV } = await import("@codemirror/view");
    const dirtyListener = EV.updateListener.of((update) => {
      if (update.docChanged) {
        onDirty();
      }
    });

    // Final guard — tab may have been closed during second await
    if (!paneEl?.querySelector(`[data-tab-id="${tabId}"]`)) return;
    if (viewMap.has(tabId)) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: isReadOnly ? extensions : [...extensions, dirtyListener],
      }),
      parent: container,
    });

    viewMap.set(tabId, view);

    // Initialize lastSavedContent snapshot AFTER viewMap.set so the store
    // mutation can't re-trigger the mount-lifecycle $effect while this
    // mount is still in-flight (issue #41).
    tabStore.setLastSavedContent(tabId, content);

    // #62: an anchor click that opened this tab via `tabStore.openTab` will
    // have queued a `scrollStore.requestScrollToRange` BEFORE the view
    // existed. The scrollStore subscriber only fires on store changes and
    // bails when the view isn't in `viewMap`, so without this peek the
    // request stays pending forever. Consume it now that the view is
    // ready and the file path matches.
    {
      const pending = get(scrollStore).pending;
      if (pending && pending.filePath === tabFilePath && pending.range) {
        const docLen = view.state.doc.length;
        const from = Math.min(pending.range.from, docLen);
        const to = Math.min(pending.range.to, docLen);
        if (from < to) scrollToMatch(view, from, to);
        scrollStore.clearPending();
      }
    }

    // Attach wiki-link-click listener only on editable markdown tabs —
    // read-only previews don't have the wiki-link plugin loaded so no
    // wiki-link-click events would ever fire from them anyway.
    if (!isReadOnly) {
      view.dom.addEventListener("wiki-link-click", handleWikiLinkClick);
    }

    // Sync editorStore if this is the active tab
    if (tabId === paneActiveTabId) {
      editorStore.syncFromTab(tabFilePath, content, null);
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
        const action = await decideExternalModifyAction(
          { getFileHash, mergeExternalChange, sha256Hex },
          { path, editorContent, lastSavedContent },
        );

        if (action.kind === "sync-hash") {
          // Disk bytes match the editor — either our own write slipped past
          // the WriteIgnoreList TTL or an external tool touched the file
          // without changing content. Refresh the hash tracker so the next
          // autosave doesn't re-detect a phantom mismatch.
          tabStore.setLastSavedHash(tabWithPath.id, action.diskHash);
          tabStore.setLastSavedContent(tabWithPath.id, editorContent);
          tabStore.setDirty(tabWithPath.id, false);
          editorStore.setLastSavedHash(action.diskHash);
        } else if (action.kind === "clean-merge") {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: action.mergedContent },
          });
          tabStore.setLastSavedContent(tabWithPath.id, action.mergedContent);
          tabStore.setLastSavedHash(tabWithPath.id, action.diskHash);
          editorStore.setLastSavedHash(action.diskHash);
          toastStore.push({
            variant: "clean-merge",
            message: `Externe Änderungen wurden in ${filename} eingebunden.`,
          });
        } else {
          tabStore.setLastSavedContent(tabWithPath.id, editorContent);
          tabStore.setLastSavedHash(tabWithPath.id, action.diskHash);
          editorStore.setLastSavedHash(action.diskHash);
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
    unsubResolvedLinks();
    unsubEditorHash();
    unlistenFileChange?.();
    unlistenVaultStatus?.();
    for (const view of viewMap.values()) {
      view.destroy();
    }
    viewMap.clear();
  });
</script>

<div
  class="vc-editor-pane"
  bind:this={paneEl}
>
  <TabBar
    {paneId}
    tabs={paneTabs}
    activeTabId={paneActiveTabId}
  />

  <!-- Breadcrumb path bar — self-hides when no tab is open (AC-06). -->
  <Breadcrumbs
    filePath={paneActiveFilePath}
    tabId={paneActiveTabSupportsReading && paneActiveTab ? paneActiveTab.id : null}
    viewMode={paneActiveTabSupportsReading && paneActiveTab ? (paneActiveTab.viewMode ?? "edit") : undefined}
  />

  <!-- Editor content area -->
  <div class="vc-editor-content" class:has-graph-bg={showGraphBg}>
    {#if paneTabs.length === 0}
      <div class="vc-editor-empty">
        <p class="vc-editor-empty-heading">No file open</p>
        <p class="vc-editor-empty-body">Select a file from the sidebar to get started.</p>
      </div>
    {/if}
    <!-- #87: ambient local-graph background behind the editor in edit mode -->
    <EditorGraphBackground visible={showGraphBg} relPath={bgRelPath} />
    <!-- #380: 120ms char-morph overlay between text-file tabs. Sits above
         the editor containers (z-index: 5) but below the readonly scrim
         (z-index: 10). pointer-events: none so the editor stays interactive. -->
    <TabMorphOverlay bind:this={morphOverlay} />
    <!-- Svelte renders one container per tab. Visibility is driven by
         style:display reacting to paneActiveTabId — no manual DOM needed.
         Graph tabs render <GraphView /> instead of a CM6 container so the
         file-load path is skipped entirely (#32). -->
    {#each paneTabs as tab (tab.id)}
      {#if tab.type === "graph"}
        <div
          class="vc-editor-container"
          data-tab-id={tab.id}
          style:display={tab.id === paneActiveTabId ? "block" : "none"}
        >
          <GraphView />
        </div>
      {:else if tab.viewer === "image"}
        <div
          class="vc-editor-container"
          data-tab-id={tab.id}
          style:display={tab.id === paneActiveTabId ? "block" : "none"}
        >
          <ImagePreview abs={tab.filePath} />
        </div>
      {:else if tab.viewer === "unsupported"}
        <div
          class="vc-editor-container"
          data-tab-id={tab.id}
          style:display={tab.id === paneActiveTabId ? "block" : "none"}
        >
          <UnsupportedPreview abs={tab.filePath} />
        </div>
      {:else if tab.viewer === "canvas"}
        <div
          class="vc-editor-container"
          data-tab-id={tab.id}
          style:display={tab.id === paneActiveTabId ? "block" : "none"}
        >
          <CanvasView tabId={tab.id} abs={tab.filePath} />
        </div>
      {:else}
        <!-- #63: both containers are rendered; visibility is toggled by
             tab.viewMode so switching modes doesn't destroy the CM6 view
             (preserves undo history + load state). -->
        <div
          class="vc-editor-container"
          data-tab-id={tab.id}
          style:display={tab.id === paneActiveTabId && (tab.viewMode ?? "edit") === "edit" ? "block" : "none"}
        ></div>
        {#if (tab.viewMode ?? "edit") === "read"}
          <div
            class="vc-editor-container"
            data-reading-tab-id={tab.id}
            style:display={tab.id === paneActiveTabId ? "block" : "none"}
          >
            <ReadingView {tab} isActive={tab.id === paneActiveTabId} />
          </div>
        {/if}
      {/if}
    {/each}
  </div>

  {#if paneTabs.length > 0 && tabHasEditor(paneTabs.find((t) => t.id === paneActiveTabId))}
    <CountStatusBar {paneId} />
  {/if}

  {#if !vaultReachable}
    <div class="vc-editor-readonly-overlay"></div>
  {/if}

  <!-- #301: custom right-click menu + visual template-expression builder.
       The menu entry order matches the ticket — the custom action sits at
       the top, then the standard clipboard actions. -->
  <ContextMenu
    open={contextMenuOpen}
    x={contextMenuPos.x}
    y={contextMenuPos.y}
    onClose={closeContextMenu}
  >
    <button class="vc-context-item" onclick={menuAction_openBuilder}>Insert template expression…</button>
    <div class="vc-context-separator"></div>
    <button class="vc-context-item" onclick={menuAction_cut}>Cut</button>
    <button class="vc-context-item" onclick={menuAction_copy}>Copy</button>
    <button class="vc-context-item" onclick={menuAction_paste}>Paste</button>
    <button class="vc-context-item" onclick={menuAction_selectAll}>Select All</button>
  </ContextMenu>

  <TemplateExpressionBuilder
    open={templateBuilderOpen}
    dynamicPropertyKeys={templateBuilderKeys}
    onInsert={onBuilderInsert}
    onCancel={onBuilderCancel}
  />

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
    z-index: 1;
  }

  /* #87: semi-transparent editor backgrounds so the ambient graph shows through */
  .vc-editor-content.has-graph-bg :global(.cm-editor) {
    background-color: color-mix(in srgb, var(--color-bg) 55%, transparent) !important;
  }
  .vc-editor-content.has-graph-bg :global(.cm-content) {
    background-color: color-mix(in srgb, var(--color-surface) 70%, transparent) !important;
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

</style>
