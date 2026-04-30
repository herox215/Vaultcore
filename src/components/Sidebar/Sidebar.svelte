<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { FilePlus, FolderPlus, Network, ChevronDown, FileText, LayoutDashboard, BookOpen } from "lucide-svelte";
  import {
    listDirectory,
    createFile,
    createFolder,
    writeFile,
    getBacklinks,
    moveFile,
    updateLinksAfterRename,
  } from "../../ipc/commands";
  import { serializeCanvas, emptyCanvas } from "../../lib/canvas/parse";
  import { commandRegistry } from "../../lib/commands/registry";
  import { CMD_IDS } from "../../lib/commands/defaultCommands";
  import {
    loadTreeState,
    saveTreeState,
    sortEntries,
    type TreeState,
    DEFAULT_TREE_STATE,
  } from "../../lib/treeState";
  import { vaultStore } from "../../store/vaultStore";
  import { toastStore } from "../../store/toastStore";
  import { progressStore } from "../../store/progressStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import type { DirEntry } from "../../types/tree";
  import {
    listenFileChange,
    listenBulkChangeStart,
    listenBulkChangeEnd,
    type FileChangePayload,
    type BulkChangePayload,
  } from "../../ipc/events";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { tabStore } from "../../store/tabStore";
  import { tabReloadStore } from "../../store/tabReloadStore";
  import { resolvedLinksStore } from "../../store/resolvedLinksStore";
  import type {
    RenameCascadeRequest,
    MoveDropRequest,
    PendingRename,
    PendingMove,
  } from "../../types/sidebar";
  import { openHomeCanvas } from "../../lib/homeCanvas";
  import { openDocsPage } from "../../lib/docsPage";
  import { searchStore } from "../../store/searchStore";
  import { treeRefreshStore } from "../../store/treeRefreshStore";
  import { treeRevealStore } from "../../store/treeRevealStore";
  import { tagsStore } from "../../store/tagsStore";
  import { Hash } from "lucide-svelte";
  import TreeRow from "./TreeRow.svelte";
  import ProgressBar from "../Progress/ProgressBar.svelte";
  import TagsPanel from "../Tags/TagsPanel.svelte";
  import BookmarksPanel from "../Bookmarks/BookmarksPanel.svelte";
  import { bookmarksStore } from "../../store/bookmarksStore";
  import {
    flattenTree,
    ancestorRelPaths,
    toRelPath as flatToRelPath,
    type FlatRow,
    type FolderState,
    type TreeModel,
  } from "../../lib/flattenTree";

  // #253 — the sidebar is now the single owner of:
  //   - the tree model (per-folder FolderState + persisted `expanded`)
  //   - the `treeRevealStore` subscription (rows do NOT subscribe individually)
  //   - the flattened row list + virtualized renderer

  interface Props {
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onOpenFile: (path: string) => void;
    onOpenContentSearch: (query: string) => void;
  }

  let { selectedPath, onSelect, onOpenFile, onOpenContentSearch }: Props = $props();

  // ─── Tree model ────────────────────────────────────────────────────────────
  let rootEntries = $state<DirEntry[]>([]);
  let folders = $state<Map<string, FolderState>>(new Map());
  let loadError = $state<string | null>(null);
  let loading = $state(false);
  let bulkActive = $state(false);
  let bulkCount = $state(0);
  let treeState = $state<TreeState>({ ...DEFAULT_TREE_STATE });

  // ─── Header split/dropdown state ───────────────────────────────────────────
  let newMenuOpen = $state(false);
  const newNoteHotkey = $derived(commandRegistry.getEffectiveHotkey(CMD_IDS.NEW_NOTE));
  const newCanvasHotkey = $derived(commandRegistry.getEffectiveHotkey(CMD_IDS.NEW_CANVAS));

  function formatHotkey(h: { meta: boolean; shift?: boolean; key: string } | undefined): string {
    if (!h) return "";
    const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
    const meta = h.meta ? (isMac ? "⌘" : "Ctrl+") : "";
    const shift = h.shift ? (isMac ? "⇧" : "Shift+") : "";
    const key = h.key.length === 1 ? h.key.toUpperCase() : h.key;
    return isMac ? `${meta}${shift}${key}` : `${meta}${shift}${key}`;
  }

  // ─── Flat-list derivation ──────────────────────────────────────────────────
  const treeModel = $derived<TreeModel>({
    vaultPath: $vaultStore.currentPath ?? "",
    rootEntries,
    folders,
    expanded: new Set(treeState.expanded),
    sortBy: treeState.sortBy,
  });

  const flatRows = $derived(flattenTree(treeModel));

  // ─── Virtualization state ──────────────────────────────────────────────────
  const ROW_HEIGHT = 28; // px — keep in sync with the CSS var below
  const OVERSCAN = 10;   // rows above + below the viewport

  let scrollerEl = $state<HTMLDivElement | null>(null);
  let viewportHeight = $state(600);
  let scrollTop = $state(0);

  // The row currently inline-renaming. We always keep it inside the window so
  // the InlineRename input never recycles out.
  let renamingPath = $state<string | null>(null);

  // #378 — cascade-confirm dialog state. Owned by Sidebar so it survives the
  // watcher-driven re-flatten that destroys the source TreeRow during rename
  // or move. Per-row ownership was the original defect.
  let pendingRename = $state<PendingRename | null>(null);
  let pendingMove = $state<PendingMove | null>(null);

  const startIdx = $derived.by(() => {
    const first = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
    return Math.max(0, first);
  });
  const endIdx = $derived.by(() => {
    const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
    const last = Math.floor(scrollTop / ROW_HEIGHT) + visibleRows + OVERSCAN;
    return Math.min(flatRows.length, last);
  });

  /** Rows we render in the DOM — window slice plus the rename-target pin. */
  const windowRows = $derived.by<Array<{ row: FlatRow; index: number }>>(() => {
    const slice: Array<{ row: FlatRow; index: number }> = [];
    for (let i = startIdx; i < endIdx; i += 1) {
      slice.push({ row: flatRows[i]!, index: i });
    }
    // Pin the renaming row if it's outside the window — never destroy the
    // input while the user is typing.
    if (renamingPath) {
      const already = slice.some((s) => s.row.path === renamingPath);
      if (!already) {
        const ri = flatRows.findIndex((r) => r.path === renamingPath);
        if (ri !== -1) slice.push({ row: flatRows[ri]!, index: ri });
      }
    }
    return slice;
  });

  const topSpacer = $derived(startIdx * ROW_HEIGHT);
  const bottomSpacer = $derived(Math.max(0, (flatRows.length - endIdx) * ROW_HEIGHT));

  // ─── IPC loaders ───────────────────────────────────────────────────────────
  async function loadRoot() {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const isInitialLoad = rootEntries.length === 0;
    if (isInitialLoad) loading = true;
    loadError = null;
    try {
      const raw = await listDirectory(vaultPath);
      rootEntries = sortEntries(raw, treeState.sortBy);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      loadError = vaultErrorCopy(ve);
      toastStore.push({ variant: "error", message: loadError });
    } finally {
      if (isInitialLoad) loading = false;
    }
  }

  async function loadFolder(folderAbsPath: string): Promise<DirEntry[] | null> {
    const existing = folders.get(folderAbsPath);
    if (existing?.loading) return existing.children ? [...existing.children] : null;
    setFolderState(folderAbsPath, {
      children: existing?.children,
      childrenLoaded: existing?.childrenLoaded ?? false,
      loading: true,
    });
    try {
      const raw = await listDirectory(folderAbsPath);
      setFolderState(folderAbsPath, {
        children: raw,
        childrenLoaded: true,
        loading: false,
      });
      return raw;
    } catch (e) {
      setFolderState(folderAbsPath, {
        children: existing?.children,
        childrenLoaded: existing?.childrenLoaded ?? false,
        loading: false,
      });
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
      return null;
    }
  }

  function setFolderState(path: string, next: FolderState) {
    // Assign a fresh Map so Svelte's reactivity picks up the change — Svelte 5
    // doesn't deeply track Map mutations.
    const m = new Map(folders);
    m.set(path, next);
    folders = m;
  }

  /** Re-fetch a folder whose children may have changed on disk. */
  async function refreshFolder(folderAbsPath: string) {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    if (folderAbsPath === vaultPath || folderAbsPath === "") {
      await loadRoot();
      return;
    }
    await loadFolder(folderAbsPath);
  }

  // ─── Toggle expand / persist ───────────────────────────────────────────────
  async function onToggleExpand(row: FlatRow) {
    if (!row.isDir) return;
    const willExpand = !treeState.expanded.includes(row.relPath);
    if (willExpand) {
      // Optimistically show the folder as expanded (with spinner) while the
      // load is in flight. Persist only once listDirectory resolves — matches
      // #336 B3 so a failure doesn't stick in `expanded` across sessions.
      const expanded = new Set(treeState.expanded);
      expanded.add(row.relPath);
      treeState = { ...treeState, expanded: Array.from(expanded) };
      const existing = folders.get(row.path);
      if (!existing || !existing.childrenLoaded) {
        const result = await loadFolder(row.path);
        if (result === null) {
          // Roll back the optimistic expand so the folder collapses and the
          // next session doesn't show an empty, un-retryable expanded node.
          const rolled = new Set(treeState.expanded);
          rolled.delete(row.relPath);
          treeState = { ...treeState, expanded: Array.from(rolled) };
          void saveTreeState($vaultStore.currentPath ?? "", treeState);
          return;
        }
      }
      void saveTreeState($vaultStore.currentPath ?? "", treeState);
    } else {
      const expanded = new Set(treeState.expanded);
      expanded.delete(row.relPath);
      treeState = { ...treeState, expanded: Array.from(expanded) };
      void saveTreeState($vaultStore.currentPath ?? "", treeState);
    }
  }

  async function setExpanded(relPath: string, absPath: string, on: boolean) {
    if (on) {
      // #336 B3 — do NOT persist `expanded` until listDirectory resolves
      // successfully. If it fails, the folder stays collapsed so the next
      // session doesn't show an empty, un-retryable expanded folder.
      const existing = folders.get(absPath);
      const needsLoad = !existing || !existing.childrenLoaded;
      if (needsLoad) {
        const result = await loadFolder(absPath);
        if (result === null) {
          // Load failed — leave treeState.expanded untouched.
          return;
        }
      }
      if (treeState.expanded.includes(relPath)) return;
      const expanded = new Set(treeState.expanded);
      expanded.add(relPath);
      treeState = { ...treeState, expanded: Array.from(expanded) };
      // Fire-and-forget the persistence — it uses crypto.subtle.digest which
      // can hang several ticks; we don't want that delaying the user-visible
      // listDirectory that populates the expanded folder.
      void saveTreeState($vaultStore.currentPath ?? "", treeState);
    } else {
      if (!treeState.expanded.includes(relPath)) return;
      const expanded = new Set(treeState.expanded);
      expanded.delete(relPath);
      treeState = { ...treeState, expanded: Array.from(expanded) };
      void saveTreeState($vaultStore.currentPath ?? "", treeState);
    }
  }

  // ─── Watcher handlers ──────────────────────────────────────────────────────
  let unlistenFileChange: UnlistenFn | null = null;
  let unlistenBulkStart: UnlistenFn | null = null;
  let unlistenBulkEnd: UnlistenFn | null = null;

  function handleFileChange(payload: FileChangePayload) {
    const { path, kind, new_path } = payload;
    if (kind === "create" || kind === "delete" || kind === "rename") {
      // Invalidate the entire tree cache — safest for arbitrary watcher events.
      invalidateAllFolders();
      void loadRoot();
      if (kind === "delete") tabStore.closeByPath(path);
      if (kind === "rename" && new_path) tabStore.updateFilePath(path, new_path);
    }
  }

  function invalidateAllFolders() {
    // Keep `expanded` state intact (persisted), but drop cached child lists so
    // folders re-fetch next time they're expanded / walked.
    folders = new Map();
  }

  function handleBulkStart(payload: BulkChangePayload) {
    bulkActive = true;
    bulkCount = payload.estimated_count;
    progressStore.start(payload.estimated_count);
  }

  function handleBulkEnd() {
    bulkActive = false;
    bulkCount = 0;
    progressStore.finish();
    invalidateAllFolders();
    void loadRoot();
  }

  // ─── Mount / destroy ───────────────────────────────────────────────────────
  let prevRefreshToken: string | null = null;
  let unsubTreeRefresh: (() => void) | null = null;
  let prevRevealToken: string | null = null;
  let unsubTreeReveal: (() => void) | null = null;

  let prevVaultPathSeen: string | null = null;
  let unsubVaultPathSidebar: (() => void) | null = null;

  function handleVaultStateChange(state: { currentPath: string | null }) {
    if (state.currentPath !== prevVaultPathSeen) {
      prevVaultPathSeen = state.currentPath;
      if (state.currentPath) {
        invalidateAllFolders();
        const cp = state.currentPath;
        void (async () => {
          try {
            const ts = await loadTreeState(cp);
            treeState = { ...ts };
          } catch {
            /* keep defaults */
          }
        })();
        void loadRoot();
        void tagsStore.reload();
        void bookmarksStore.load(state.currentPath);
      } else {
        bookmarksStore.reset();
      }
    }
  }

  onMount(async () => {
    // #253 — vault subscription must live inside onMount so that async
    // treeState assignments flow through Svelte 5's reactive graph (a
    // top-level-script subscription fires during component construction,
    // before the reactive root is fully wired, and mutations from its
    // async continuation never reach the `$derived` graph).
    unsubVaultPathSidebar = vaultStore.subscribe(handleVaultStateChange);

    unlistenFileChange = await listenFileChange(handleFileChange);
    unlistenBulkStart = await listenBulkChangeStart(handleBulkStart);
    unlistenBulkEnd = await listenBulkChangeEnd(handleBulkEnd);

    unsubTreeRefresh = treeRefreshStore.subscribe((state) => {
      if (state.token && state.token !== prevRefreshToken) {
        prevRefreshToken = state.token;
        invalidateAllFolders();
        void loadRoot();
        if ($vaultStore.currentPath) void tagsStore.reload();
      }
    });

    // #253 — single reveal-store subscription. Handles: expand ancestors →
    // wait for listDirectory → re-flatten → scroll target into view.
    unsubTreeReveal = treeRevealStore.subscribe((state) => {
      if (!state.pending) return;
      if (state.pending.token === prevRevealToken) return;
      prevRevealToken = state.pending.token;
      void performReveal(state.pending.relPath);
    });

    // Measure viewport height once mounted.
    measureViewport();
    if (typeof ResizeObserver !== "undefined" && scrollerEl) {
      const ro = new ResizeObserver(measureViewport);
      ro.observe(scrollerEl);
      onDestroyCallbacks.push(() => ro.disconnect());
    }
  });

  const onDestroyCallbacks: Array<() => void> = [];

  onDestroy(() => {
    unlistenFileChange?.();
    unlistenBulkStart?.();
    unlistenBulkEnd?.();
    unsubTreeRefresh?.();
    unsubTreeReveal?.();
    unsubVaultPathSidebar?.();
    onDestroyCallbacks.forEach((fn) => fn());
    tagsStore.reset();
  });

  // #336 B2 — if a reveal fires while the scroller has 0 height (collapsed
  // sidebar, pre-layout mount), stash it and drain once the scroller has a
  // real clientHeight.
  let pendingRevealPath: string | null = null;

  function measureViewport() {
    if (scrollerEl) {
      const newHeight = scrollerEl.clientHeight || viewportHeight;
      viewportHeight = newHeight;
      // Drain the stashed reveal once the layout is actually present.
      if (pendingRevealPath !== null && scrollerEl.clientHeight > 0) {
        const pending = pendingRevealPath;
        pendingRevealPath = null;
        void performReveal(pending);
      }
    }
  }

  function onScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    scrollTop = el.scrollTop;
  }

  // ─── Reveal pipeline ───────────────────────────────────────────────────────
  /**
   * Expand every ancestor folder of `relPath`, await each listDirectory, then
   * scroll the target row into view. Sequenced so the flat list has grown to
   * include the target before we try to scroll to it.
   */
  async function performReveal(relPath: string) {
    searchStore.setActiveTab("files");

    const vaultPath = $vaultStore.currentPath ?? "";
    if (!vaultPath) return;

    const ancestors = ancestorRelPaths(relPath);
    // Walk ancestors top-down so each subsequent listDirectory has its parent
    // already resolved.
    for (const ancestorRel of ancestors) {
      const ancestorAbs = vaultPath + "/" + ancestorRel;
      await setExpanded(ancestorRel, ancestorAbs, true);
    }

    // Recompute the flat list after the DOM has caught up with the new state.
    await tick();

    // #336 B1 — do NOT read the `flatRows` $derived here. Svelte 5 batches
    // reactive updates; a $derived value read from inside a store-subscription
    // callback (even across an `await tick()`) can return its previous value
    // when the triggering $state was mutated in an async continuation. Recompute
    // from `treeModel`'s backing fields directly to get a guaranteed-fresh slice.
    const fresh = flattenTree({
      vaultPath,
      rootEntries,
      folders,
      expanded: new Set(treeState.expanded),
      sortBy: treeState.sortBy,
    });

    const targetAbs = relPath.length > 0 ? vaultPath + "/" + relPath : vaultPath;
    const idx = fresh.findIndex((r) => r.path === targetAbs);
    if (idx === -1) {
      // Target path isn't in the flat list (maybe points at a .md file under
      // an ancestor whose listDirectory hasn't landed yet). Best-effort: no
      // scroll — the caller can re-dispatch after the user's next keystroke.
      return;
    }

    // #336 B2 — if the scroller has no layout yet, stash the request and
    // let `measureViewport` drain it once it gets a real clientHeight.
    if (!scrollerEl || scrollerEl.clientHeight === 0) {
      pendingRevealPath = relPath;
      return;
    }

    // Place the target ~1/3 down the viewport so it's visibly centered.
    const targetTop = idx * ROW_HEIGHT;
    const vh = scrollerEl.clientHeight || viewportHeight;
    const desiredTop = Math.max(0, targetTop - vh / 3);
    if (targetTop < scrollerEl.scrollTop || targetTop > scrollerEl.scrollTop + vh - ROW_HEIGHT) {
      scrollerEl.scrollTop = desiredTop;
      scrollTop = desiredTop;
      await tick();
    }

    // Find the row element (it now should exist in the DOM window) and
    // scroll-into-view. The window-slice update is reactive but pixel-level
    // scroll happens after the next paint, so poll a few rAF frames before
    // falling back to best-effort index scroll.
    const scrollTarget = (): boolean => {
      const el = scrollerEl?.querySelector<HTMLElement>(
        `[data-tree-row="${cssEscape(targetAbs)}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return true;
      }
      return false;
    };
    if (scrollTarget()) return;
    if (typeof requestAnimationFrame === "function") {
      let attempts = 0;
      const tryRaf = () => {
        if (scrollTarget()) return;
        attempts += 1;
        if (attempts < 3) requestAnimationFrame(tryRaf);
        // else: accept best-effort — scrollTop is already at desiredTop.
      };
      requestAnimationFrame(tryRaf);
    }
  }

  function cssEscape(value: string): string {
    // Lightweight CSS escape — we only need to guard quotes/backslashes/newlines.
    // (CSS.escape is not reliably available in the Tauri webview.)
    return value.replace(/["\\\n\r]/g, (c) => "\\" + c);
  }

  // ─── Row callbacks ─────────────────────────────────────────────────────────
  function onRenameStateChange(path: string, renaming: boolean) {
    renamingPath = renaming ? path : renamingPath === path ? null : renamingPath;
  }

  function handlePathChanged(oldPath: string, newPath: string) {
    tabStore.updateFilePath(oldPath, newPath);
    // Invalidate the containing folder — a rename may have reordered entries.
    const parent = parentOf(oldPath);
    if (parent) void refreshFolder(parent);
    else void loadRoot();
  }

  // #378 — cascade-request handlers from TreeRow. The row hands the request
  // up the moment the IPC await resolves (synchronously, no further await),
  // so the closure capture cannot race the row's unmount. Sidebar then runs
  // any post-IPC work on its own always-mounted lifetime.
  //
  // `cascadeClaiming` is a synchronous slot reservation. The handler does an
  // `await getBacklinks(...)` before it can populate the full `pendingRename`
  // / `pendingMove` shape; checking only those state fields would let a second
  // request pass the guard and race for the slot during that await window.
  // `cascadeClaiming` is set before the await and the synthetic guard reads
  // it, closing the re-entrancy window without flashing a half-populated
  // dialog.
  let cascadeClaiming = $state(false);

  function cascadeBusy(): boolean {
    return cascadeClaiming || pendingRename !== null || pendingMove !== null;
  }

  async function handleRequestRenameCascade(req: RenameCascadeRequest) {
    if (cascadeBusy()) return;
    cascadeClaiming = true;
    let fileCount = 1;
    try {
      const backlinks = await getBacklinks(req.oldRelPath);
      fileCount = new Set(backlinks.map((b) => b.sourcePath)).size || 1;
    } catch {
      /* fall back to the linkCount/1 default */
    } finally {
      pendingRename = { ...req, fileCount };
      cascadeClaiming = false;
    }
  }

  async function handleRequestMoveCascade(req: MoveDropRequest) {
    if (cascadeBusy()) return;
    cascadeClaiming = true;
    try {
      const vault = $vaultStore.currentPath;
      if (!vault) return;
      const { sourcePath, targetDirPath } = req;
      const sourceRelPath = sourcePath.startsWith(vault + "/")
        ? sourcePath.slice(vault.length + 1)
        : sourcePath;
      const sourceFilename = sourcePath.split("/").pop() ?? sourcePath;
      const newAbsPath = targetDirPath + "/" + sourceFilename;
      const newRelPath = newAbsPath.startsWith(vault + "/")
        ? newAbsPath.slice(vault.length + 1)
        : newAbsPath;

      let linkCount = 0;
      let fileCount = 0;
      try {
        const backlinks = await getBacklinks(sourceRelPath);
        linkCount = backlinks.length;
        fileCount = new Set(backlinks.map((b) => b.sourcePath)).size;
      } catch {
        /* proceed without cascade */
      }

      if (linkCount > 0) {
        pendingMove = {
          sourcePath,
          targetDirPath,
          sourceRelPath,
          newRelPath,
          linkCount,
          fileCount,
        };
        return;
      }

      // No-cascade direct move — was previously inside TreeRow.handleDrop.
      try {
        await moveFile(sourcePath, targetDirPath);
        void bookmarksStore.renamePath(sourceRelPath, newRelPath, vault);
        await refreshFolder(targetDirPath);
        const parent = parentOf(sourcePath);
        if (parent) await refreshFolder(parent);
        resolvedLinksStore.requestReload();
      } catch (err) {
        const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
        toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
      }
    } finally {
      cascadeClaiming = false;
    }
  }

  async function confirmRenameWithLinks() {
    if (!pendingRename) return;
    // Snapshot but DO NOT clear pendingRename yet — clearing before the
    // IPC settles would let a second cascade request slip past the modal
    // guard in handleRequest*Cascade and trigger concurrent link rewrites.
    // Keep the dialog open while applying; clear only when the IPC resolves.
    const { oldPath, newPath, oldRelPath, newRelPath } = pendingRename;
    handlePathChanged(oldPath, newPath);
    resolvedLinksStore.requestReload();
    try {
      const result = await updateLinksAfterRename(oldRelPath, newRelPath);
      if (result.updatedPaths.length > 0) {
        tabReloadStore.request(result.updatedPaths);
      }
      if (result.failedFiles.length > 0) {
        const total = result.updatedLinks + result.failedFiles.length;
        toastStore.push({
          variant: "error",
          message: `${result.updatedLinks} von ${total} Links aktualisiert. ${result.failedFiles.length} Dateien konnten nicht geändert werden.`,
        });
      }
    } catch {
      toastStore.push({
        variant: "error",
        message: "Links konnten nicht aktualisiert werden.",
      });
    } finally {
      pendingRename = null;
    }
  }

  function cancelRenameWithLinks() {
    pendingRename = null;
  }

  async function confirmMoveWithLinks() {
    if (!pendingMove) return;
    // Same re-entrancy reasoning as confirmRenameWithLinks — keep the modal
    // guard armed across the whole IPC chain.
    const { sourcePath, targetDirPath, sourceRelPath, newRelPath } = pendingMove;
    try {
      await moveFile(sourcePath, targetDirPath);
      const vaultForBookmarks = $vaultStore.currentPath;
      if (vaultForBookmarks) {
        void bookmarksStore.renamePath(sourceRelPath, newRelPath, vaultForBookmarks);
      }
      await refreshFolder(targetDirPath);
      const parent = parentOf(sourcePath);
      if (parent) await refreshFolder(parent);
      resolvedLinksStore.requestReload();
      const result = await updateLinksAfterRename(sourceRelPath, newRelPath);
      if (result.updatedPaths.length > 0) {
        tabReloadStore.request(result.updatedPaths);
      }
      if (result.failedFiles.length > 0) {
        const total = result.updatedLinks + result.failedFiles.length;
        toastStore.push({
          variant: "error",
          message: `${result.updatedLinks} von ${total} Links aktualisiert. ${result.failedFiles.length} Dateien konnten nicht geändert werden.`,
        });
      }
    } catch (err) {
      const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    } finally {
      pendingMove = null;
    }
  }

  function cancelMoveWithLinks() {
    pendingMove = null;
  }

  function parentOf(absPath: string): string | null {
    const i = absPath.lastIndexOf("/");
    if (i <= 0) return null;
    return absPath.slice(0, i);
  }

  // ─── Header actions ────────────────────────────────────────────────────────
  async function handleNewFile() {
    newMenuOpen = false;
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      await createFile(targetFolder, "");
      if (targetFolder === vaultPath) await loadRoot();
      else await refreshFolder(targetFolder);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewCanvas() {
    newMenuOpen = false;
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      const newPath = await createFile(targetFolder, "Untitled.canvas");
      await writeFile(newPath, serializeCanvas(emptyCanvas()));
      if (targetFolder === vaultPath) await loadRoot();
      else await refreshFolder(targetFolder);
      tabStore.openFileTab(newPath, "canvas");
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  async function handleNewFolder() {
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    const targetFolder = getSelectedFolder() ?? vaultPath;
    try {
      await createFolder(targetFolder, "");
      if (targetFolder === vaultPath) await loadRoot();
      else await refreshFolder(targetFolder);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function getSelectedFolder(): string | null {
    if (!selectedPath) return null;
    const entry = rootEntries.find((e) => e.path === selectedPath);
    if (entry?.is_dir) return selectedPath;
    return null;
  }

  const vaultName = $derived(
    $vaultStore.currentPath
      ? $vaultStore.currentPath.split("/").pop() ?? $vaultStore.currentPath
      : "No vault",
  );
</script>

<aside class="vc-sidebar" data-testid="sidebar">
  <div class="vc-sidebar-tabs" role="tablist">
    <button
      class="vc-sidebar-tab"
      role="tab"
      aria-selected={$searchStore.activeTab === 'files'}
      onclick={() => searchStore.setActiveTab('files')}
    >Dateien</button>
    <button
      type="button"
      class="vc-sidebar-tab"
      role="tab"
      aria-selected={$searchStore.activeTab === 'tags'}
      aria-label="Tags-Bereich"
      onclick={() => searchStore.setActiveTab('tags')}
    >
      <Hash size={14} />
      <span>Tags</span>
    </button>
  </div>

  {#if $searchStore.activeTab === 'tags'}
    <div class="vc-sidebar-tabpanel" role="tabpanel">
      <TagsPanel {onOpenContentSearch} />
    </div>
  {:else}
  <header class="vc-sidebar-header">
    {#if bulkActive}
      <div class="vc-sidebar-bulk-progress">
        <span class="vc-sidebar-bulk-label">Scanning changes...</span>
        <span class="vc-sidebar-bulk-count">{bulkCount.toLocaleString()} files</span>
      </div>
    {:else}
      <button
        type="button"
        class="vc-sidebar-vaultname"
        title={`Open home (${$vaultStore.currentPath ?? ""})`}
        onclick={() => { void openHomeCanvas(); }}
        data-testid="sidebar-vaultname-home"
      >
        {vaultName}
      </button>
      <div class="vc-sidebar-actions" style="position: relative;">
        <div class="vc-new-split" data-testid="sidebar-new-split">
          <button
            class="vc-sidebar-action-btn vc-new-split-primary"
            onclick={handleNewFile}
            aria-label="New note"
            title={`New note${newNoteHotkey ? ` (${formatHotkey(newNoteHotkey)})` : ""}`}
            data-testid="sidebar-new-note"
          >
            <FilePlus size={16} strokeWidth={1.5} />
          </button>
          <button
            class="vc-sidebar-action-btn vc-new-split-chevron"
            onclick={() => { newMenuOpen = !newMenuOpen; }}
            aria-label="More file types"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            title="More file types"
            data-testid="sidebar-new-menu-toggle"
          >
            <ChevronDown size={12} strokeWidth={1.5} />
          </button>
          {#if newMenuOpen}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="vc-new-overlay"
              onclick={() => { newMenuOpen = false; }}
              role="presentation"
            ></div>
            <div class="vc-new-menu" role="menu" data-testid="sidebar-new-menu">
              <button
                class="vc-new-menu-item"
                role="menuitem"
                onclick={handleNewFile}
                data-testid="sidebar-new-menu-note"
              >
                <FileText size={14} strokeWidth={1.5} />
                <span class="vc-new-menu-label">New note</span>
                {#if newNoteHotkey}
                  <span class="vc-new-menu-hotkey">{formatHotkey(newNoteHotkey)}</span>
                {/if}
              </button>
              <button
                class="vc-new-menu-item"
                role="menuitem"
                onclick={handleNewCanvas}
                data-testid="sidebar-new-menu-canvas"
              >
                <LayoutDashboard size={14} strokeWidth={1.5} />
                <span class="vc-new-menu-label">New canvas</span>
                {#if newCanvasHotkey}
                  <span class="vc-new-menu-hotkey">{formatHotkey(newCanvasHotkey)}</span>
                {/if}
              </button>
            </div>
          {/if}
        </div>
        <button
          class="vc-sidebar-action-btn"
          onclick={handleNewFolder}
          aria-label="New folder"
          title="New folder"
        >
          <FolderPlus size={16} strokeWidth={1.5} />
        </button>
        <button
          class="vc-sidebar-action-btn"
          onclick={() => tabStore.openGraphTab()}
          aria-label="Open graph"
          title="Open graph (Cmd/Ctrl+Shift+G)"
        >
          <Network size={16} strokeWidth={1.5} />
        </button>
        <button
          class="vc-sidebar-action-btn"
          onclick={() => { void openDocsPage(); }}
          aria-label="Open docs"
          title="Open documentation (Cmd/Ctrl+Shift+/)"
          data-testid="sidebar-open-docs"
        >
          <BookOpen size={16} strokeWidth={1.5} />
        </button>
      </div>
    {/if}
  </header>

  <BookmarksPanel />

  <!-- Tree area (virtualized) -->
  <div
    class="vc-sidebar-tree"
    role="tree"
    aria-label="Vault file tree"
    bind:this={scrollerEl}
    onscroll={onScroll}
  >
    {#if loading}
      <p class="vc-sidebar-status">Loading...</p>
    {:else if loadError}
      <p class="vc-sidebar-status vc-sidebar-status--error">{loadError}</p>
    {:else if flatRows.length === 0}
      <p class="vc-sidebar-status">No files in vault.</p>
    {:else}
      <ul
        class="vc-tree-root"
        role="group"
        style="padding-top: {topSpacer}px; padding-bottom: {bottomSpacer}px;"
      >
        {#each windowRows as { row, index } (row.path)}
          <TreeRow
            {row}
            {selectedPath}
            {onSelect}
            {onOpenFile}
            onToggleExpand={(r) => onToggleExpand(r)}
            onEnsureExpanded={(r) => setExpanded(r.relPath, r.path, true)}
            onRefreshFolder={refreshFolder}
            onPathChanged={handlePathChanged}
            {onRenameStateChange}
            onRequestRenameCascade={handleRequestRenameCascade}
            onRequestMoveCascade={handleRequestMoveCascade}
          />
        {/each}
      </ul>
    {/if}
  </div>

  {#if pendingRename}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-confirm-overlay vc-modal-scrim"
      onclick={cancelRenameWithLinks}
      role="presentation"
    ></div>
    <div
      class="vc-confirm-dialog vc-modal-surface"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-heading"
    >
      <h2 id="rename-heading" class="vc-confirm-heading">Links aktualisieren?</h2>
      <p class="vc-confirm-body">
        {pendingRename.linkCount} Links in {pendingRename.fileCount} Dateien werden aktualisiert. Fortfahren?
      </p>
      <div class="vc-confirm-actions">
        <button class="vc-confirm-btn vc-confirm-btn--cancel" onclick={cancelRenameWithLinks}>Abbrechen</button>
        <button class="vc-confirm-btn vc-confirm-btn--accent" onclick={() => void confirmRenameWithLinks()}>Aktualisieren</button>
      </div>
    </div>
  {/if}

  {#if pendingMove}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-confirm-overlay vc-modal-scrim"
      onclick={cancelMoveWithLinks}
      role="presentation"
    ></div>
    <div
      class="vc-confirm-dialog vc-modal-surface"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-heading"
    >
      <h2 id="move-heading" class="vc-confirm-heading">Links aktualisieren?</h2>
      <p class="vc-confirm-body">
        {pendingMove.linkCount} Links in {pendingMove.fileCount} Dateien werden aktualisiert. Fortfahren?
      </p>
      <div class="vc-confirm-actions">
        <button class="vc-confirm-btn vc-confirm-btn--cancel" onclick={cancelMoveWithLinks}>Abbrechen</button>
        <button class="vc-confirm-btn vc-confirm-btn--accent" onclick={() => void confirmMoveWithLinks()}>Aktualisieren</button>
      </div>
    </div>
  {/if}
  {/if}
</aside>

<style>
  /* #378 — cascade-confirm dialog styles. Lifted from TreeRow alongside the
     pendingRename / pendingMove state so the dialog's CSS scope follows its
     owning component. TreeRow keeps the same selectors for its delete-confirm
     dialog — Svelte's scoped-style hashing keeps the two copies isolated. */
  .vc-confirm-overlay {
    z-index: 199;
  }

  .vc-confirm-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 200;
    width: 280px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    padding: 16px;
  }

  .vc-confirm-heading {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px 0;
    color: var(--color-text);
  }

  .vc-confirm-body {
    font-size: 14px;
    color: var(--color-text);
    margin: 0 0 16px 0;
    line-height: 1.5;
  }

  .vc-confirm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .vc-confirm-btn {
    padding: 6px 14px;
    font-size: 14px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    cursor: pointer;
    background: var(--color-surface);
    color: var(--color-text);
    /* #385 — token undefined on desktop → fallback `auto` (byte-identical
       padding-only height); coarse → 44px. */
    min-height: var(--vc-hit-target, auto);
  }

  .vc-confirm-btn:hover {
    background: var(--color-accent-bg);
  }

  .vc-confirm-btn--cancel {
    background: var(--color-surface);
  }

  .vc-confirm-btn--accent {
    min-width: 80px;
    padding: 4px 8px;
    border: 1px solid var(--color-accent);
    color: var(--color-accent);
    background: transparent;
  }

  .vc-confirm-btn--accent:hover {
    background: var(--color-accent-bg);
  }

  .vc-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg);
    overflow: hidden;
  }

  .vc-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 40px;
    min-height: 40px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    flex-shrink: 0;
  }

  .vc-sidebar-vaultname {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    margin-right: 8px;
    background: none;
    border: none;
    padding: 4px 6px;
    margin-left: -6px;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    font-family: inherit;
  }

  .vc-sidebar-vaultname:hover {
    background: var(--color-bg);
  }

  .vc-sidebar-vaultname:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .vc-sidebar-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .vc-sidebar-action-btn {
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
    padding: 0;
  }

  .vc-sidebar-action-btn:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-new-split {
    display: inline-flex;
    align-items: stretch;
    border-radius: 4px;
  }

  .vc-new-split-primary {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    padding-right: 4px;
  }

  .vc-new-split-chevron {
    width: 18px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    padding: 0;
    margin-left: -2px;
  }

  .vc-new-split:hover .vc-sidebar-action-btn {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-new-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .vc-new-menu {
    position: absolute;
    top: 36px;
    right: 0;
    z-index: 100;
    min-width: 200px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    padding: 4px 0;
  }

  .vc-new-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    font-size: 14px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
  }

  .vc-new-menu-item:hover {
    background: var(--color-accent-bg);
  }

  .vc-new-menu-label {
    flex: 1;
  }

  .vc-new-menu-hotkey {
    font-size: 12px;
    color: var(--color-text-muted);
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .vc-sidebar-bulk-progress {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0 4px;
  }

  .vc-sidebar-bulk-label {
    font-size: 12px;
    color: var(--color-accent);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .vc-sidebar-bulk-count {
    font-size: 11px;
    color: var(--color-text-muted);
    flex-shrink: 0;
    margin-left: 8px;
  }

  .vc-sidebar-tree {
    flex: 1 1 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .vc-tree-root {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    --vc-tree-row-height: 28px;
  }

  .vc-sidebar-status {
    padding: 16px;
    font-size: 12px;
    color: var(--color-text-muted);
    margin: 0;
  }

  .vc-sidebar-status--error {
    color: var(--color-error);
  }

  .vc-sidebar-tabpanel {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }
</style>
