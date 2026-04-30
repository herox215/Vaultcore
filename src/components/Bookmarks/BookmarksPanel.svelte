<script lang="ts">
  // Bookmarks panel (#12). Collapsible section rendered above the file tree.
  // State:
  //   - collapsed: persisted in localStorage under BOOKMARKS_COLLAPSED_KEY
  //   - rows: derived from bookmarksStore.paths
  //   - broken-bookmark detection: bookmark rel path not present in
  //     $vaultStore.fileList renders dimmed with a hover-visible Remove button.
  import { Star, ChevronRight, ChevronDown, X } from "lucide-svelte";
  import { bookmarksStore } from "../../store/bookmarksStore";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore } from "../../store/tabStore";
  import { longPress, type LongPressDetail } from "../../lib/actions/longPress";
  import { openFileAsTab } from "../../lib/openFileAsTab";

  const BOOKMARKS_COLLAPSED_KEY = "vaultcore-bookmarks-panel-collapsed";

  let collapsed = $state(false);
  let contextMenu = $state<{ path: string; x: number; y: number } | null>(null);

  // Drag-to-reorder state
  let dragSourceIdx = $state<number | null>(null);
  let dragOverIdx = $state<number | null>(null);

  // Restore collapsed state from localStorage on mount.
  (function restoreCollapsed() {
    try {
      const raw = localStorage.getItem(BOOKMARKS_COLLAPSED_KEY);
      if (raw !== null) collapsed = raw === "true";
    } catch {
      // localStorage unavailable (SSR, etc.) — keep default.
    }
  })();

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    try {
      localStorage.setItem(BOOKMARKS_COLLAPSED_KEY, String(collapsed));
    } catch {
      // ignore
    }
  }

  function toAbsPath(relPath: string): string {
    const vaultPath = $vaultStore.currentPath ?? "";
    if (!vaultPath) return relPath;
    return `${vaultPath}/${relPath}`;
  }

  function displayName(relPath: string): string {
    const parts = relPath.split("/");
    return parts[parts.length - 1] ?? relPath;
  }

  function isBroken(relPath: string): boolean {
    const list = $vaultStore.fileList;
    if (!list || list.length === 0) return false;
    return !list.includes(relPath);
  }

  function handleRowClick(relPath: string): void {
    // #388 — route through openFileAsTab so the dispatcher applies the
    // viewport-aware viewMode default (mobile → read, desktop → edit).
    void openFileAsTab(toAbsPath(relPath));
  }

  function handleRowKeydown(e: KeyboardEvent, relPath: string): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleRowClick(relPath);
    }
  }

  function openContextMenu(e: MouseEvent, relPath: string): void {
    e.preventDefault();
    e.stopPropagation();
    contextMenu = { path: relPath, x: e.clientX, y: e.clientY };
  }

  function onRowLongPress(d: LongPressDetail, relPath: string): void {
    contextMenu = { path: relPath, x: d.clientX, y: d.clientY };
  }

  function closeContextMenu(): void {
    contextMenu = null;
  }

  function handleOpenInNewTab(relPath: string): void {
    closeContextMenu();
    // #388 — route through openFileAsTab so the dispatcher applies the
    // viewport-aware viewMode default. Dedupe semantics (focus existing tab)
    // are preserved by the underlying tabStore.openTab call.
    void openFileAsTab(toAbsPath(relPath));
  }

  function handleOpenInSplit(relPath: string): void {
    closeContextMenu();
    const absPath = toAbsPath(relPath);
    // #388 — stays sync: handleOpenInSplit is a synchronous event handler
    // and cannot `await openFileAsTab` without restructuring the call site.
    // The mobile-aware viewMode hint is lost on the split path; split is
    // desktop-only via viewport gating, so this is moot in practice.
    tabStore.openTab(absPath);
    tabStore.moveToPane("right");
  }

  async function handleRemoveBookmark(relPath: string): Promise<void> {
    closeContextMenu();
    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;
    await bookmarksStore.remove(relPath, vaultPath);
  }

  // Drag-and-drop reorder — mirror TabBar pattern.
  function handleDragStart(e: DragEvent, idx: number): void {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("text/vaultcore-bookmark", String(idx));
    e.dataTransfer.effectAllowed = "move";
    dragSourceIdx = idx;
  }

  function handleDragEnd(): void {
    dragSourceIdx = null;
    dragOverIdx = null;
  }

  function handleDragOver(e: DragEvent, idx: number): void {
    if (!e.dataTransfer?.types.includes("text/vaultcore-bookmark")) return;
    e.preventDefault();
    dragOverIdx = idx;
  }

  async function handleDrop(e: DragEvent, idx: number): Promise<void> {
    if (!e.dataTransfer?.types.includes("text/vaultcore-bookmark")) return;
    e.preventDefault();
    const fromRaw = e.dataTransfer.getData("text/vaultcore-bookmark");
    const from = Number.parseInt(fromRaw, 10);
    dragOverIdx = null;
    dragSourceIdx = null;
    if (!Number.isFinite(from) || from === idx) return;

    const vaultPath = $vaultStore.currentPath;
    if (!vaultPath) return;

    const current = [...$bookmarksStore.paths];
    if (from < 0 || from >= current.length) return;
    const moved = current[from];
    if (moved === undefined) return;
    current.splice(from, 1);
    const insertAt = idx > from ? idx - 1 : idx;
    current.splice(insertAt, 0, moved);
    await bookmarksStore.reorder(current, vaultPath);
  }
</script>

<svelte:window onclick={closeContextMenu} />

<section class="vc-bookmarks-panel" aria-label="Lesezeichen">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <button
    type="button"
    class="vc-bookmarks-header"
    aria-expanded={!collapsed}
    onclick={toggleCollapsed}
  >
    <span class="vc-bookmarks-chevron" aria-hidden="true">
      {#if collapsed}
        <ChevronRight size={14} strokeWidth={1.5} />
      {:else}
        <ChevronDown size={14} strokeWidth={1.5} />
      {/if}
    </span>
    <Star size={14} strokeWidth={1.5} />
    <span class="vc-bookmarks-title">Bookmarks</span>
    <span class="vc-bookmarks-count">{$bookmarksStore.paths.length}</span>
  </button>

  {#if !collapsed}
    <ul class="vc-bookmarks-list" data-testid="vc-bookmarks-list">
      {#each $bookmarksStore.paths as relPath, idx (relPath)}
        {@const broken = isBroken(relPath)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li
          class="vc-bookmark-row"
          class:vc-bookmark-row--broken={broken}
          class:vc-bookmark-row--drag-over={dragOverIdx === idx && dragSourceIdx !== idx}
          draggable="true"
          ondragstart={(e) => handleDragStart(e, idx)}
          ondragend={handleDragEnd}
          ondragover={(e) => handleDragOver(e, idx)}
          ondrop={(e) => void handleDrop(e, idx)}
          oncontextmenu={(e) => openContextMenu(e, relPath)}
          use:longPress={{ onLongPress: (d) => onRowLongPress(d, relPath) }}
        >
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <button
            type="button"
            class="vc-bookmark-label"
            onclick={() => handleRowClick(relPath)}
            onkeydown={(e) => handleRowKeydown(e, relPath)}
            title={broken ? `${relPath} (nicht gefunden)` : relPath}
          >
            <Star size={12} strokeWidth={1.5} />
            <span class="vc-bookmark-name">{displayName(relPath)}</span>
          </button>
          {#if broken}
            <button
              type="button"
              class="vc-bookmark-remove"
              aria-label="Lesezeichen entfernen"
              title="Lesezeichen entfernen"
              onclick={() => void handleRemoveBookmark(relPath)}
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          {/if}
        </li>
      {/each}
      {#if $bookmarksStore.paths.length === 0}
        <li class="vc-bookmarks-empty">Keine Lesezeichen</li>
      {/if}
    </ul>
  {/if}

  {#if contextMenu}
    <div
      class="vc-bookmark-menu"
      role="menu"
      style="top: {contextMenu.y}px; left: {contextMenu.x}px"
    >
      <button
        type="button"
        class="vc-bookmark-menu-item"
        role="menuitem"
        onclick={() => handleOpenInNewTab(contextMenu!.path)}
      >
        In neuem Tab öffnen
      </button>
      <button
        type="button"
        class="vc-bookmark-menu-item"
        role="menuitem"
        onclick={() => handleOpenInSplit(contextMenu!.path)}
      >
        Im Split öffnen
      </button>
      <button
        type="button"
        class="vc-bookmark-menu-item vc-bookmark-menu-item--danger"
        role="menuitem"
        onclick={() => void handleRemoveBookmark(contextMenu!.path)}
      >
        Lesezeichen entfernen
      </button>
    </div>
  {/if}
</section>

<style>
  .vc-bookmarks-panel {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
    flex-shrink: 0;
  }

  .vc-bookmarks-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .vc-bookmarks-header:hover {
    background: var(--color-accent-bg);
  }

  .vc-bookmarks-chevron {
    display: flex;
    align-items: center;
  }

  .vc-bookmarks-title {
    flex: 1;
  }

  .vc-bookmarks-count {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .vc-bookmarks-list {
    list-style: none;
    margin: 0;
    padding: 0 0 4px 0;
    max-height: 240px;
    overflow-y: auto;
  }

  .vc-bookmark-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    position: relative;
  }

  .vc-bookmark-row:hover {
    background: var(--color-accent-bg);
  }

  .vc-bookmark-row--broken .vc-bookmark-label {
    color: var(--color-text-muted);
    font-style: italic;
    opacity: 0.6;
  }

  .vc-bookmark-row--drag-over {
    border-top: 2px solid var(--color-accent);
  }

  .vc-bookmark-label {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 4px 0 4px 16px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
    font-size: 13px;
    text-align: left;
  }

  .vc-bookmark-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vc-bookmark-remove {
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    border-radius: 3px;
    padding: 0;
    flex-shrink: 0;
  }

  .vc-bookmark-row:hover .vc-bookmark-remove {
    display: flex;
  }

  .vc-bookmark-remove:hover {
    background: var(--color-surface);
    color: var(--color-error);
  }

  .vc-bookmarks-empty {
    padding: 6px 24px;
    font-size: 12px;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .vc-bookmark-menu {
    position: fixed;
    z-index: 400;
    min-width: 180px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    padding: 4px 0;
  }

  .vc-bookmark-menu-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    font-size: 13px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
  }

  .vc-bookmark-menu-item:hover {
    background: var(--color-accent-bg);
  }

  .vc-bookmark-menu-item--danger {
    color: var(--color-error);
  }
</style>
