<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { PanelRight, Settings as SettingsIcon } from "lucide-svelte";
  import Sidebar from "../Sidebar/Sidebar.svelte";
  import EditorPane from "../Editor/EditorPane.svelte";
  import OmniSearch from "../Search/OmniSearch.svelte";
  import CommandPalette from "../CommandPalette/CommandPalette.svelte";
  import TemplatePicker from "../TemplatePicker/TemplatePicker.svelte";
  import RightSidebar from "./RightSidebar.svelte";
  import SettingsModal from "../Settings/SettingsModal.svelte";
  import ReindexStatusbar from "../Statusbar/ReindexStatusbar.svelte";
  import { tabStore } from "../../store/tabStore";
  import { searchStore } from "../../store/searchStore";
  import { backlinksStore } from "../../store/backlinksStore";
  import { bookmarksStore } from "../../store/bookmarksStore";
  import { vaultStore } from "../../store/vaultStore";
  import { commandRegistry } from "../../lib/commands/registry";
  import { registerDefaultCommands } from "../../lib/commands/defaultCommands";
  import {
    createFile,
    createFolder,
    exportNoteHtml,
    listDirectory,
    pickSavePath,
    readFile,
    renderNoteHtml,
    writeFile,
  } from "../../ipc/commands";
  import { collectThemeCss, defaultExportFilename } from "../../lib/exportHtml";
  import { listenFileChange } from "../../ipc/events";
  import { initHotkeyOverrides } from "../../lib/commands/hotkeyOverrides";
  import { toastStore } from "../../store/toastStore";
  import { treeRefreshStore } from "../../store/treeRefreshStore";
  import { treeRevealStore } from "../../store/treeRevealStore";
  import { openFileAsTab } from "../../lib/openFileAsTab";
  import { resolveRevealRelPath } from "../../lib/activeTabReveal";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import { settingsStore } from "../../store/settingsStore";
  import {
    DEFAULT_DAILY_DATE_FORMAT,
    dailyNoteFilename,
    splitFolderSegments,
  } from "../../lib/dailyNotes";
  import { emptyCanvas, serializeCanvas } from "../../lib/canvas/parse";

  let { onSwitchVault }: { onSwitchVault: () => void } = $props();

  const SIDEBAR_WIDTH_KEY = "vaultcore-sidebar-width";
  const DEFAULT_SIDEBAR_WIDTH = 240;
  const MIN_SIDEBAR_WIDTH = 160;
  const MAX_SIDEBAR_WIDTH = 480;
  const MIN_PANE_WIDTH = 240;

  let sidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
  let sidebarCollapsed = $state(false);
  let isDragging = $state(false);
  let omniSearchOpen = $state(false);
  let omniSearchMode = $state<"filename" | "content">("filename");
  let omniSearchPrefill = $state<string | undefined>(undefined);
  let commandPaletteOpen = $state(false);
  let templatePickerOpen = $state(false);
  let settingsOpen = $state(false);
  let dragStartX = 0;
  let dragStartWidth = 0;

  // Right sidebar drag-to-resize state
  let isRightDragging = $state(false);
  let rightDragStartX = 0;
  let rightDragStartWidth = 0;

  // Split view state from tabStore
  let rightPaneIds = $state<string[]>([]);
  let splitRatio = $state(0.5);
  let isSplitDragging = $state(false);
  let splitDragStartX = 0;
  let splitDragStartRatio = 0;

  // Sidebar selection state
  let selectedPath = $state<string | null>(null);

  const unsubTab = tabStore.subscribe((state) => {
    rightPaneIds = state.splitState.right;
  });

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

  // Sidebar divider drag-to-resize
  function handleDividerMousedown(e: MouseEvent) {
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartWidth = sidebarWidth;
  }

  function handleMousemove(e: MouseEvent) {
    if (isDragging) {
      const delta = e.clientX - dragStartX;
      const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, dragStartWidth + delta));
      sidebarWidth = newWidth;
    }
    if (isSplitDragging) {
      handleSplitDragMove(e);
    }
    if (isRightDragging) {
      // Right divider drag: dragging left increases sidebar width
      const delta = rightDragStartX - e.clientX;
      backlinksStore.setWidth(rightDragStartWidth + delta);
    }
  }

  function handleMouseup() {
    if (isDragging) {
      isDragging = false;
      persistWidth(sidebarWidth);
    }
    if (isSplitDragging) {
      isSplitDragging = false;
    }
    if (isRightDragging) {
      isRightDragging = false;
    }
  }

  function handleRightDividerMousedown(e: MouseEvent) {
    e.preventDefault();
    isRightDragging = true;
    rightDragStartX = e.clientX;
    // Snapshot the current width via get(); avoids the throwaway
    // subscribe/unsub closure allocation pattern (#259).
    rightDragStartWidth = get(backlinksStore).width;
  }

  // Split pane divider drag
  function handleSplitDividerMousedown(e: MouseEvent) {
    e.preventDefault();
    isSplitDragging = true;
    splitDragStartX = e.clientX;
    splitDragStartRatio = splitRatio;
  }

  function handleSplitDragMove(e: MouseEvent) {
    if (!isSplitDragging) return;
    const editorAreaEl = document.querySelector(".vc-layout-editor") as HTMLElement;
    if (!editorAreaEl) return;

    const editorRect = editorAreaEl.getBoundingClientRect();
    const totalWidth = editorRect.width;
    const x = e.clientX - editorRect.left;
    const newRatio = Math.max(
      MIN_PANE_WIDTH / totalWidth,
      Math.min(1 - MIN_PANE_WIDTH / totalWidth, x / totalWidth)
    );
    splitRatio = newRatio;
  }

  onMount(() => {
    document.addEventListener("mousemove", handleMousemove);
    document.addEventListener("mouseup", handleMouseup);
    return () => {
      document.removeEventListener("mousemove", handleMousemove);
      document.removeEventListener("mouseup", handleMouseup);
    };
  });

  // Subscribe to tabStore to sync active file to backlinksStore.
  // tabStore emits on every per-keystroke mutation (setDirty, scroll position,
  // lastSavedContent); re-dispatching setActiveFile on every emit flips the
  // panel into loading state and fires an IPC round-trip, causing the sidebar
  // to flicker as the user types. Only push through when the resolved rel
  // path actually changes.
  let unsubBacklinksTab: (() => void) | null = null;
  let lastDispatchedRelPath: string | null | undefined = undefined;
  onMount(() => {
    unsubBacklinksTab = tabStore.subscribe((state) => {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      // #259: snapshot vault path via get() — tabStore emits on every
      // per-keystroke mutation (setDirty, scroll, cursor) and a throwaway
      // vaultStore.subscribe/unsub here would allocate a fresh closure and
      // run the full subscriber cycle on every keypress.
      const vault = get(vaultStore).currentPath;

      let nextRelPath: string | null;
      if (!activeTab || !vault) {
        nextRelPath = null;
      } else {
        const absPath = activeTab.filePath;
        nextRelPath = absPath.startsWith(vault + "/")
          ? absPath.slice(vault.length + 1)
          : absPath;
      }

      if (nextRelPath === lastDispatchedRelPath) return;
      lastDispatchedRelPath = nextRelPath;
      backlinksStore.setActiveFile(nextRelPath);
    });
  });

  // Issue #50: reveal + select the active editor tab in the sidebar tree.
  // Any tab activation (tree click, Quick Switcher, wiki-link, backlinks,
  // bookmarks, Cmd+N, cycle, close) flows through tabStore.activeTabId,
  // so a single subscription here covers every entry point. We guard by
  // the computed rel path so per-keystroke mutations (setDirty, scroll)
  // don't re-issue the same reveal on every tabStore emission.
  let unsubActiveTabReveal: (() => void) | null = null;
  let lastRevealedRelPath: string | null | undefined = undefined;
  onMount(() => {
    unsubActiveTabReveal = tabStore.subscribe((state) => {
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
      // #259: snapshot vault path via get() — see the backlinks-sync
      // subscription above for the per-keystroke hot-path rationale.
      const vault = get(vaultStore).currentPath;
      const relPath = resolveRevealRelPath(activeTab, vault);
      if (relPath === lastRevealedRelPath) return;
      lastRevealedRelPath = relPath;
      selectedPath = relPath !== null && vault !== null
        ? `${vault}/${relPath}`
        : null;
      if (relPath !== null) {
        treeRevealStore.requestReveal(relPath);
      }
    });
  });

  onDestroy(() => {
    unsubTab();
    unsubBacklinksTab?.();
    unsubActiveTabReveal?.();
    document.removeEventListener("mousemove", handleMousemove);
    document.removeEventListener("mouseup", handleMouseup);
  });

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
  }

  /** T-05-03-03: Suppress global shortcuts when an inline rename input is focused. */
  function inlineRenameActive(): boolean {
    const el = document.activeElement;
    return !!el && typeof (el as Element).closest === "function" && !!(el as Element).closest('.vc-inline-rename');
  }

  /** EDIT-11 / D-12: Create "Unbenannte Notiz.md" at vault root and open in a new tab. */
  async function createNewNote() {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    try {
      const newPath = await createFile(vaultPath, "Unbenannte Notiz.md");
      tabStore.openTab(newPath);
      treeRefreshStore.requestRefresh();
    } catch {
      toastStore.push({ variant: "error", message: "Neue Notiz konnte nicht erstellt werden." });
    }
  }

  // #145 — global "New canvas" / "New folder" commands. Palette + Cmd+Shift+C
  // share this path; the sidebar header dropdown calls its own local handler
  // because it needs to target the currently-selected folder, whereas the
  // palette shortcut always drops the new item at the vault root (the palette
  // is reachable even when no tree row is selected).
  async function createNewCanvas() {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    try {
      const newPath = await createFile(vaultPath, "Untitled.canvas");
      await writeFile(newPath, serializeCanvas(emptyCanvas()));
      tabStore.openFileTab(newPath, "canvas");
      treeRefreshStore.requestRefresh();
    } catch {
      toastStore.push({ variant: "error", message: "Neues Canvas konnte nicht erstellt werden." });
    }
  }

  async function createNewFolder() {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;
    try {
      await createFolder(vaultPath, "");
      treeRefreshStore.requestRefresh();
    } catch {
      toastStore.push({ variant: "error", message: "Neuer Ordner konnte nicht erstellt werden." });
    }
  }

  /**
   * Issue #59: open (or create) today's daily note.
   *
   * Resolution order:
   *  1. Resolve the target folder from settingsStore.dailyNotesFolder. Each
   *     segment is created if missing (listDirectory probe avoids the
   *     createFolder auto-suffix that would make "Daily" turn into
   *     "Daily 1").
   *  2. Build the filename from today's local date using the configured
   *     format (minimal YYYY/MM/DD token subset — see lib/dailyNotes.ts).
   *  3. If the file already exists (detected by listing the parent),
   *     reuse the existing absolute path so we never overwrite.
   *  4. Otherwise createFile() writes an empty file; if a template path is
   *     configured AND readable, its contents are then written into the
   *     new file. Unreadable template silently falls back to empty.
   */
  async function openTodayNote() {
    const vaultPath = get(vaultStore).currentPath;
    if (!vaultPath) return;

    const settings = get(settingsStore);
    const folder = settings.dailyNotesFolder;
    const format = settings.dailyNotesDateFormat.trim().length > 0
      ? settings.dailyNotesDateFormat
      : DEFAULT_DAILY_DATE_FORMAT;
    const template = settings.dailyNotesTemplate.trim();

    try {
      // 1. Resolve / create folder chain.
      const vault: string = vaultPath;
      let parent: string = vault;
      for (const segment of splitFolderSegments(folder)) {
        const candidate = `${parent}/${segment}`;
        try {
          await listDirectory(candidate);
          parent = candidate;
        } catch {
          // listDirectory throws for "doesn't exist" — create it.
          parent = await createFolder(parent, segment);
        }
      }

      // 2. Build filename from today's local date.
      const filename = dailyNoteFilename(new Date(), format);

      // 3. If the note already exists, open it without modifying.
      let existingAbsPath: string | null = null;
      try {
        const entries = await listDirectory(parent);
        const hit = entries.find((e) => !e.is_dir && e.name === filename);
        if (hit) existingAbsPath = hit.path;
      } catch {
        // Listing a just-created folder can race — treat as "no existing file".
      }
      if (existingAbsPath) {
        tabStore.openTab(existingAbsPath);
        return;
      }

      // 4. Create the file (createFile auto-suffixes on collision, but step 3
      //    already ruled collision out, so the returned path matches `filename`).
      const newPath = await createFile(parent, filename);

      // Seed with template contents if configured and readable.
      if (template.length > 0) {
        const templateAbs = `${vault}/${template.replace(/^[/\\]+/, "")}`;
        try {
          const contents = await readFile(templateAbs);
          await writeFile(newPath, contents);
        } catch {
          // Missing/unreadable template — leave the note empty. No toast:
          // AC explicitly says this must not block creation.
        }
      }

      tabStore.openTab(newPath);
      treeRefreshStore.requestRefresh();
    } catch {
      toastStore.push({ variant: "error", message: "Tagesnotiz konnte nicht geöffnet werden." });
    }
  }

  /**
   * Issue #61: export the active note as a self-contained HTML file.
   *
   * Flow:
   *  1. Resolve the active markdown tab; abort silently for non-file tabs
   *     (graph, image, etc.) — export doesn't apply.
   *  2. Pop the native save dialog so the user picks any location (not vault-
   *     scoped; the HTML file is meant to be shared outside the vault).
   *  3. Snapshot the applied theme's CSS variables and hand them to Rust
   *     alongside the note path; Rust reads the markdown, inlines
   *     `![[image.png]]` embeds as base64 `data:` URLs, rewrites resolvable
   *     `[[heading]]` wiki-links into `#slug` anchors, and writes the final
   *     document.
   */
  async function exportActiveNoteHtml() {
    const active = tabStore.getActiveTab();
    if (!active || active.type === "graph") {
      toastStore.push({ variant: "error", message: "Keine Notiz aktiv." });
      return;
    }
    if (active.viewer !== undefined && active.viewer !== "markdown") {
      toastStore.push({ variant: "error", message: "Nur Markdown-Notizen können exportiert werden." });
      return;
    }
    const defaultName = defaultExportFilename(active.filePath, "html");
    let chosen: string | null;
    try {
      chosen = await pickSavePath(defaultName, [
        { name: "HTML", extensions: ["html", "htm"] },
      ]);
    } catch (err) {
      const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
      return;
    }
    if (chosen === null) return;
    try {
      const themeCss = collectThemeCss();
      await exportNoteHtml(active.filePath, chosen, themeCss);
      const filename = chosen.split(/[\\/]/).pop() ?? chosen;
      toastStore.push({ variant: "clean-merge", message: `Notiz als HTML exportiert — ${filename}` });
    } catch (err) {
      const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  /**
   * Issue #61 stretch: render the active note via the same Rust pipeline used
   * by HTML export, then drop the result into a hidden iframe and call
   * `window.print()`. The native dialog exposes "Save as PDF" on every major
   * platform — no Tauri print plugin required.
   */
  async function exportActiveNotePdf() {
    const active = tabStore.getActiveTab();
    if (!active || active.type === "graph") {
      toastStore.push({ variant: "error", message: "Keine Notiz aktiv." });
      return;
    }
    if (active.viewer !== undefined && active.viewer !== "markdown") {
      toastStore.push({ variant: "error", message: "Nur Markdown-Notizen können exportiert werden." });
      return;
    }
    try {
      const themeCss = collectThemeCss();
      const html = await renderNoteHtml(active.filePath, themeCss);
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      // srcdoc keeps the document in-memory (no blob URL to revoke) so cleanup
      // is simple and there is no same-origin / CSP surprise for the print hook.
      iframe.srcdoc = html;
      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } finally {
          // Give the webview a moment to surface the print dialog before we
          // tear down the iframe.
          setTimeout(() => iframe.remove(), 1000);
        }
      };
      document.body.appendChild(iframe);
      toastStore.push({ variant: "clean-merge", message: "Druckdialog geöffnet — wähle »Als PDF speichern«." });
    } catch (err) {
      const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  /** Issue #63: toggle Reading vs Edit mode on the active markdown tab. */
  function toggleActiveReadingMode() {
    const active = tabStore.getActiveTab();
    if (!active) return;
    // Only markdown file tabs support reading mode — graph tabs and non-
    // markdown viewers (image / unsupported / text-preview) stay as-is.
    if (active.type === "graph") return;
    if (active.viewer === "image" || active.viewer === "unsupported") return;
    tabStore.toggleViewMode(active.id);
  }

  /** Issue #12: toggle bookmark on the active tab's file path. */
  async function toggleActiveBookmark() {
    const vaultPath = get(vaultStore).currentPath;
    if (vaultPath === null) return;
    const active = tabStore.getActiveTab();
    if (!active || active.type === "graph") return;
    const abs = active.filePath;
    const prefix = `${vaultPath}/`;
    if (!abs.startsWith(prefix)) return;
    const rel = abs.slice(prefix.length).replace(/\\/g, "/");
    await bookmarksStore.toggle(rel, vaultPath);
  }

  function handleSelect(path: string) {
    selectedPath = path;
  }

  function openContentSearchWith(query: string) {
    omniSearchMode = "content";
    omniSearchPrefill = query;
    omniSearchOpen = true;
  }

  function handleOpenFile(path: string) {
    // Wire sidebar open-file to tabStore (Plan 03 / #49). Markdown opens
    // synchronously; non-markdown is dispatched to a viewer via openFileAsTab.
    selectedPath = path;
    void openFileAsTab(path).catch((err) => {
      const ve = isVaultError(err) ? err : { kind: "Io" as const, message: String(err), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    });
  }

  // Global keyboard shortcuts — delegated to the command registry (#13).
  // Attached in CAPTURE phase so the handler fires before any descendant
  // (CodeMirror editor, modal inputs, etc.) can stopPropagation on Cmd/Ctrl
  // combos we own. Bubble-phase attachment was unreliable once the editor
  // had focus.
  onMount(() => {
    registerDefaultCommands({
      openQuickSwitcher: () => {
        omniSearchMode = "filename";
        omniSearchPrefill = undefined;
        omniSearchOpen = true;
      },
      toggleSidebar: () => { toggleSidebar(); },
      openBacklinks: () => { backlinksStore.toggle(); },
      activateSearchTab: () => {
        omniSearchMode = "content";
        omniSearchPrefill = undefined;
        omniSearchOpen = true;
      },
      cycleTabNext: () => { tabStore.cycleTab(1); },
      cycleTabPrev: () => { tabStore.cycleTab(-1); },
      closeActiveTab: () => {
        const activeId = get(tabStore).activeTabId;
        if (activeId) tabStore.closeTab(activeId);
      },
      createNewNote: () => { void createNewNote(); },
      createNewCanvas: () => { void createNewCanvas(); },
      createNewFolder: () => { void createNewFolder(); },
      openGraph: () => { tabStore.openGraphTab(); },
      openCommandPalette: () => { commandPaletteOpen = true; },
      toggleBookmark: () => { void toggleActiveBookmark(); },
      openTodayNote: () => { void openTodayNote(); },
      exportActiveNoteHtml: () => { void exportActiveNoteHtml(); },
      exportActiveNotePdf: () => { void exportActiveNotePdf(); },
      toggleReadingMode: () => { toggleActiveReadingMode(); },
      insertTemplate: () => { templatePickerOpen = true; },
    });
    initHotkeyOverrides();
    document.addEventListener("keydown", handleKeydown, { capture: true });
    document.addEventListener("contextmenu", handleContextMenu, { capture: true });

    // #174 — any FS change flips the search index to "stale". The omni-search
    // modal will auto-rebuild on next open. Subscription lives here (not in
    // OmniSearch) so the flag is tracked even while the modal is closed.
    let cancelledStale = false;
    let unlistenStale: (() => void) | undefined;
    void listenFileChange(() => {
      if (!cancelledStale) searchStore.setIndexStale(true);
    }).then((fn) => {
      if (cancelledStale) { fn(); return; }
      unlistenStale = fn;
    });

    return () => {
      document.removeEventListener("keydown", handleKeydown, { capture: true });
      document.removeEventListener("contextmenu", handleContextMenu, { capture: true });
      cancelledStale = true;
      unlistenStale?.();
    };
  });

  // Issue #47: suppress the native webview context menu inside app chrome.
  // Elements that still need the OS menu (e.g. inputs in modals) can opt out
  // by attaching their own `oncontextmenu` that calls `e.stopPropagation()`.
  // The sidebar tree and bookmarks panel render their own menus so they're
  // unaffected here.
  function handleContextMenu(e: MouseEvent) {
    const target = e.target as Element | null;
    if (target && typeof target.closest === "function") {
      // Allow native menu inside real text entry (inputs, textareas,
      // contenteditable) so copy/paste/spellcheck stay available.
      if (target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
        return;
      }
    }
    e.preventDefault();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (settingsOpen || inlineRenameActive()) return;
    if (commandPaletteOpen) return; // palette handles its own keys
    if (omniSearchOpen) return; // omni-search handles its own keys
    if (templatePickerOpen) return; // template picker handles its own keys

    const cmd = commandRegistry.findByHotkey(e);
    if (!cmd) return;

    if (cmd.id === "tabs:next" && e.shiftKey) {
      e.preventDefault();
      tabStore.cycleTab(-1);
      return;
    }
    e.preventDefault();
    commandRegistry.execute(cmd.id);
  }

  const isSplit = $derived(rightPaneIds.length > 0);

  // Reactive right sidebar CSS variables derived from store
  let backlinksOpen = $state(false);
  let backlinksWidth = $state(240);
  const unsubBacklinks = backlinksStore.subscribe((s) => {
    backlinksOpen = s.open;
    backlinksWidth = s.width;
  });
</script>

<!-- keydown listener attached via document.addEventListener in onMount (capture phase) -->

<div
  class="vc-vault-layout"
  class:vc-vault-layout--dragging={isDragging || isSplitDragging || isRightDragging}
  style="--sidebar-width: {sidebarCollapsed ? 0 : sidebarWidth}px; --right-sidebar-width: {backlinksOpen ? backlinksWidth : 0}px; --vc-editor-max-width: {sidebarCollapsed ? 1100 : 720}px"
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
      onOpenContentSearch={openContentSearchWith}
    />
  </div>

  <!-- Resize divider (column 2). Always rendered — a missing element would
       let CSS grid auto-placement slide every subsequent child one column
       left, so the editor would land in the `auto` track (col 2) instead of
       `1fr` (col 3). When collapsed we swap to a zero-width sibling that
       keeps the placement anchored without showing a visible handle. -->
  {#if sidebarCollapsed}
    <div class="vc-layout-divider-hidden" aria-hidden="true"></div>
  {:else}
    <!-- role="separator" is the correct ARIA pattern for a drag-to-resize
         handle; there is no standard keyboard activation for mouse-drag
         resizing, so the mouse-only handler is intentional. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="vc-layout-divider"
      class:vc-layout-divider--active={isDragging}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      onmousedown={handleDividerMousedown}
    ></div>
  {/if}

  <!-- Editor area (3rd column) -->
  <div class="vc-layout-editor" style="--split-ratio: {splitRatio}">
    <!-- Topbar: always rendered so its buttons (sidebar toggle, backlinks,
         settings) don't vanish together with the sidebar (issue #112). The
         sidebar toggle morphs between collapse / expand based on state. -->
    <div class="vc-editor-topbar">
      <button
        class="vc-sidebar-toggle-btn"
        onclick={toggleSidebar}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {#if sidebarCollapsed}&#9654;{:else}&#9664;{/if}
      </button>
      <div class="vc-editor-topbar-spacer"></div>
      <button
        class="vc-sidebar-toggle-btn vc-backlinks-toggle-btn"
        class:vc-backlinks-toggle-btn--active={backlinksOpen}
        onclick={() => backlinksStore.toggle()}
        aria-label="Backlinks-Panel umschalten"
        aria-pressed={backlinksOpen}
        title="Backlinks-Panel umschalten (Cmd/Ctrl+Shift+B)"
      >
        <PanelRight size={16} />
      </button>
      <button
        class="vc-sidebar-toggle-btn"
        class:vc-backlinks-toggle-btn--active={settingsOpen}
        onclick={() => { settingsOpen = true; }}
        aria-label="Einstellungen"
        aria-haspopup="dialog"
        title="Einstellungen"
      >
        <SettingsIcon size={16} />
      </button>
    </div>

    <!-- Editor panes area -->
    <div class="vc-editor-panes">
      <!-- Left pane (always present).
           BUG-05.1: when not in split view, must be flex-grow: 1 (not
           splitRatio, which defaults to 0.5). CSS spec: when sum of flex-grow
           values is < 1, items only take that proportion of free space — so
           grow:0.5 with a single flex child leaves 50% empty on the right. -->
      <div
        class="vc-pane-wrapper"
        style="flex-grow: {isSplit ? splitRatio : 1}; flex-shrink: 1; flex-basis: 0; min-width: {MIN_PANE_WIDTH}px"
      >
        <EditorPane paneId="left" />
      </div>

      {#if isSplit}
        <!-- Split divider.
             role="separator" is the correct ARIA pattern for a drag-to-resize
             handle; no standard keyboard activation applies to mouse-drag
             resizing. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="vc-split-divider"
          class:vc-split-divider--active={isSplitDragging}
          role="separator"
          aria-label="Resize split panes"
          aria-orientation="vertical"
          onmousedown={handleSplitDividerMousedown}
        ></div>

        <!-- Right pane -->
        <div
          class="vc-pane-wrapper"
          style="flex-grow: {1 - splitRatio}; flex-shrink: 1; flex-basis: 0; min-width: {MIN_PANE_WIDTH}px"
        >
          <EditorPane paneId="right" />
        </div>
      {/if}
    </div>
  </div>

  <!-- Right resize divider (4th column).
       role="separator" is the correct ARIA pattern for a drag-to-resize
       handle; no standard keyboard activation applies to mouse-drag
       resizing. -->
  {#if backlinksOpen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="vc-layout-divider-right"
      class:vc-layout-divider-right--active={isRightDragging}
      role="separator"
      aria-label="Resize backlinks sidebar"
      aria-orientation="vertical"
      onmousedown={handleRightDividerMousedown}
    ></div>
  {:else}
    <div class="vc-layout-divider-right-hidden"></div>
  {/if}

  <!-- Right sidebar (5th column) -->
  <div
    class="vc-layout-right-sidebar"
    class:vc-layout-right-sidebar--hidden={!backlinksOpen}
  >
    <RightSidebar />
  </div>
</div>

<!-- #174 — Omni-search (Spotlight-style) rendered outside the grid at body level -->
<OmniSearch
  open={omniSearchOpen}
  initialMode={omniSearchMode}
  initialQuery={omniSearchPrefill}
  onClose={() => { omniSearchOpen = false; omniSearchPrefill = undefined; }}
  onOpenFile={handleOpenFile}
/>

<CommandPalette
  open={commandPaletteOpen}
  onClose={() => { commandPaletteOpen = false; }}
/>

<TemplatePicker
  open={templatePickerOpen}
  onClose={() => { templatePickerOpen = false; }}
/>

<SettingsModal
  open={settingsOpen}
  onClose={() => { settingsOpen = false; }}
  {onSwitchVault}
/>

<!-- #201: reindex progress overlay. Self-hides while idle. -->
<ReindexStatusbar />

<style>
  .vc-vault-layout {
    display: grid;
    grid-template-columns:
      var(--sidebar-width, 240px)
      auto
      1fr
      auto
      var(--right-sidebar-width, 0px);
    height: 100vh;
    background: var(--color-bg);
    overflow: hidden;
    transition: grid-template-columns 200ms ease;
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

  .vc-layout-divider-hidden {
    width: 0;
  }

  .vc-layout-editor {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--color-surface);
    overflow: hidden;
    position: relative;
  }

  .vc-editor-topbar {
    display: flex;
    align-items: center;
    height: 36px;
    padding: 0 8px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .vc-editor-topbar-spacer {
    flex: 1;
  }

  .vc-backlinks-toggle-btn--active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-backlinks-toggle-btn--active:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-editor-panes {
    flex: 1 1 0;
    display: flex;
    flex-direction: row;
    min-height: 0;
    overflow: hidden;
  }

  .vc-pane-wrapper {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .vc-split-divider {
    width: 4px;
    background: var(--color-border);
    cursor: col-resize;
    flex-shrink: 0;
    transition: background 150ms;
  }

  .vc-split-divider:hover,
  .vc-split-divider--active {
    background: var(--color-accent-bg);
  }

  .vc-sidebar-toggle-btn {
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

  .vc-sidebar-toggle-btn:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-layout-divider-right {
    width: 4px;
    background: var(--color-border);
    cursor: col-resize;
    flex-shrink: 0;
    transition: background 150ms;
  }

  .vc-layout-divider-right:hover,
  .vc-layout-divider-right--active {
    background: var(--color-accent-bg);
  }

  .vc-layout-divider-right-hidden {
    width: 0;
  }

  .vc-layout-right-sidebar {
    overflow: hidden;
    width: var(--right-sidebar-width, 0px);
    border-left: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .vc-layout-right-sidebar--hidden {
    width: 0;
    border-left: none;
    overflow: hidden;
  }
</style>
