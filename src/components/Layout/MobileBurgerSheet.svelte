<script lang="ts">
  /**
   * MobileBurgerSheet — bottom-sheet router for the mobile More tab (#397).
   *
   * Parent-gated: VaultLayout decides via `{#if isMobile}` when to render;
   * the component itself does NOT subscribe to viewportStore. State (open
   * flag, close callback) lives in the parent.
   *
   * Two views:
   *   1. Menu — a 6-row list. Default state when the sheet opens.
   *   2. Panel — the selected sub-panel rendered inline with a back button.
   *
   * Properties + Settings rows are TODO placeholders that stub-toast and
   * close the sheet; #393 and #394 will replace those branches with real
   * destinations.
   */
  import {
    Link2,
    Bookmark,
    List,
    ArrowUpRight,
    FileText,
    Settings as SettingsIcon,
    ChevronRight,
    ChevronLeft,
  } from "lucide-svelte";
  import BacklinksPanel from "../Backlinks/BacklinksPanel.svelte";
  import BookmarksPanel from "../Bookmarks/BookmarksPanel.svelte";
  import OutlinePanel from "../Outline/OutlinePanel.svelte";
  import OutgoingLinksPanel from "../OutgoingLinks/OutgoingLinksPanel.svelte";
  import { toastStore } from "../../store/toastStore";

  let {
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  } = $props();

  type PanelId = "backlinks" | "bookmarks" | "outline" | "outgoing";

  let activePanel = $state<PanelId | null>(null);
  let sheetEl: HTMLDivElement | undefined = $state(undefined);

  // Reset to the menu view whenever the sheet closes. Each open thus
  // starts on the menu — no implicit deep-link to the last-viewed panel,
  // which would surprise users coming back to the More tab for something
  // unrelated.
  $effect(() => {
    if (!open) activePanel = null;
  });

  // Focus the first focusable inside the sheet on open. Microtask wait so
  // CSS class application paints before focus jumps.
  $effect(() => {
    if (open) {
      queueMicrotask(() => {
        const first = sheetEl?.querySelector<HTMLElement>(
          'button:not([tabindex="-1"]), a:not([tabindex="-1"]), input:not([tabindex="-1"])',
        );
        first?.focus();
      });
    }
  });

  type RowSpec = {
    id: "backlinks" | "bookmarks" | "outline" | "outgoing" | "properties" | "settings";
    label: string;
    icon: typeof Link2;
    action: "panel" | "stub";
    panelId?: PanelId;
    stubMessage?: string;
  };

  // Static — labels and icons don't change at runtime. Keeping the array
  // pure data avoids the wasted-work pattern that Aristotle flagged on
  // #389 (`tabs` was wrongly $derived).
  const ROWS: ReadonlyArray<RowSpec> = [
    { id: "backlinks",  label: "Backlinks",         icon: Link2,        action: "panel", panelId: "backlinks" },
    { id: "bookmarks",  label: "Lesezeichen",       icon: Bookmark,     action: "panel", panelId: "bookmarks" },
    { id: "outline",    label: "Gliederung",        icon: List,         action: "panel", panelId: "outline" },
    { id: "outgoing",   label: "Ausgehende Links",  icon: ArrowUpRight, action: "panel", panelId: "outgoing" },
    { id: "properties", label: "Eigenschaften",     icon: FileText,     action: "stub",  stubMessage: "Eigenschaften folgen" },
    { id: "settings",   label: "Einstellungen",     icon: SettingsIcon, action: "stub",  stubMessage: "Einstellungen folgen" },
  ];

  const PANEL_LABELS: Record<PanelId, string> = {
    backlinks: "Backlinks",
    bookmarks: "Lesezeichen",
    outline: "Gliederung",
    outgoing: "Ausgehende Links",
  };

  function onRowClick(row: RowSpec) {
    if (row.action === "panel" && row.panelId) {
      activePanel = row.panelId;
      return;
    }
    // TODO #393 (properties) / #394 (settings). The toast tells the user
    // the destination exists but isn't wired yet; closing the sheet keeps
    // the More tab's tap-feedback intact (no dead-end where the menu
    // stays open after an apparent-no-op).
    if (row.stubMessage) toastStore.info(row.stubMessage);
    onClose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (activePanel !== null) {
      // Two-step Escape: panel view → menu view first; another Escape
      // would then close. Matches the drawer pattern from #386 where a
      // stacked nav element gives users an "undo last navigation"
      // affordance instead of dumping them back to the editor.
      activePanel = null;
    } else {
      onClose();
    }
  }
</script>

{#if open}
  <!-- Scrim sits below the sheet (z-index 59 vs 60). Tapping it closes;
       no role=button — it's a passive backdrop, the cursor and the sheet
       itself signal the affordance. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="vc-modal-scrim vc-mobile-burger-scrim"
    aria-hidden="true"
    tabindex="-1"
    onclick={onClose}
  ></div>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="vc-mobile-burger-sheet"
    bind:this={sheetEl}
    role="dialog"
    aria-modal="true"
    aria-label={activePanel ? PANEL_LABELS[activePanel] : "More options"}
    tabindex="-1"
    onkeydown={onKeydown}
  >
    <div class="vc-mobile-burger-handle" aria-hidden="true"></div>

    {#if activePanel === null}
      <div class="vc-mobile-burger-list" role="menu">
        {#each ROWS as row, idx (row.id)}
          {@const Icon = row.icon}
          <button
            type="button"
            role="menuitem"
            data-row-id={row.id}
            class="vc-mobile-burger-row"
            class:vc-mobile-burger-row--last={idx === ROWS.length - 1}
            onclick={() => onRowClick(row)}
          >
            <Icon size={20} strokeWidth={1.5} />
            <span class="vc-mobile-burger-row-label">{row.label}</span>
            <ChevronRight size={16} strokeWidth={1.5} />
          </button>
        {/each}
      </div>
    {:else}
      <div class="vc-mobile-burger-panel-header">
        <button
          type="button"
          class="vc-mobile-burger-back"
          onclick={() => (activePanel = null)}
          aria-label="Zurück"
        >
          <ChevronLeft size={20} strokeWidth={1.5} />
        </button>
        <span class="vc-mobile-burger-panel-title">{PANEL_LABELS[activePanel]}</span>
      </div>
      <div class="vc-mobile-burger-panel-body">
        {#if activePanel === "backlinks"}
          <BacklinksPanel />
        {:else if activePanel === "bookmarks"}
          <BookmarksPanel />
        {:else if activePanel === "outline"}
          <OutlinePanel />
        {:else if activePanel === "outgoing"}
          <OutgoingLinksPanel />
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .vc-mobile-burger-scrim {
    z-index: 59;
  }

  .vc-mobile-burger-sheet {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 60vh;
    max-height: calc(100vh - 80px);
    background: var(--color-surface);
    border-radius: 16px 16px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
    z-index: 60;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.12);
  }

  .vc-mobile-burger-handle {
    width: 36px;
    height: 4px;
    margin: 8px auto 12px auto;
    border-radius: 2px;
    background: var(--color-border);
    flex-shrink: 0;
  }

  .vc-mobile-burger-list {
    flex: 1;
    overflow-y: auto;
  }

  .vc-mobile-burger-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 56px;
    min-height: var(--vc-hit-target, 44px);
    padding: 0 16px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    color: var(--color-text);
    font-family: var(--vc-font-body);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
  }

  .vc-mobile-burger-row--last {
    border-bottom: none;
  }

  .vc-mobile-burger-row:hover {
    background: var(--color-accent-bg);
  }

  .vc-mobile-burger-row-label {
    flex: 1;
  }

  .vc-mobile-burger-panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    padding: 0 8px 0 4px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .vc-mobile-burger-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    min-width: var(--vc-hit-target, 44px);
    min-height: var(--vc-hit-target, 44px);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text-muted);
  }

  .vc-mobile-burger-back:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-mobile-burger-panel-title {
    flex: 1;
    font-family: var(--vc-font-body);
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
  }

  .vc-mobile-burger-panel-body {
    flex: 1;
    overflow-y: auto;
  }
</style>
