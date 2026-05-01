<script lang="ts">
  /**
   * MobileTabBar — fixed-bottom 3-tab nav for the mobile shell (#389).
   *
   * Parent-gated: VaultLayout decides via `{#if isMobile}` when to render
   * this component; the component itself does NOT subscribe to viewportStore.
   * State (drawer open, modal open, etc.) lives in the parent — this
   * component only emits via callbacks.
   *
   * The "More" tab is a placeholder until #397's burger sheet lands; its
   * onSelect is wired in VaultLayout to a toast for now.
   */
  import { Files, Search, Menu } from "lucide-svelte";

  let {
    drawerOpen,
    onSelectFiles,
    onSelectSearch,
    onSelectMore,
  }: {
    drawerOpen: boolean;
    onSelectFiles: () => void;
    onSelectSearch: () => void;
    onSelectMore: () => void;
  } = $props();

  type TabId = "files" | "search" | "more";
  interface TabSpec {
    id: TabId;
    label: string;
    icon: typeof Files;
    controls?: string;
  }

  // Static — labels, icons, ids, and aria-controls don't change at runtime.
  // The per-tab onclick payload dispatches via the prop callbacks; recomputing
  // this array every render would be wasted work.
  const tabs: ReadonlyArray<TabSpec> = [
    { id: "files",  label: "Dateien", icon: Files,  controls: "vc-mobile-drawer" },
    { id: "search", label: "Suche",   icon: Search                               },
    { id: "more",   label: "Mehr",    icon: Menu                                 },
  ];

  function onSelect(id: TabId) {
    if (id === "files") onSelectFiles();
    else if (id === "search") onSelectSearch();
    else onSelectMore();
  }

  // Search/More never become "active" — Search is a transient modal that
  // owns its own active state, More is a placeholder. Only Files has a
  // persistent open state (the drawer).
  const activeId = $derived<TabId | null>(drawerOpen ? "files" : null);

  // Roving tabindex: the active tab is reachable via Tab; arrow keys move
  // focus among the rest. When nothing is active, Files is the entry point
  // so the bar is keyboard-reachable from a fresh tab-press.
  function tabIndex(id: TabId, idx: number): 0 | -1 {
    if (activeId === null) return idx === 0 ? 0 : -1;
    return id === activeId ? 0 : -1;
  }

  function onTabKeydown(e: KeyboardEvent, idx: number) {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const node = document.getElementById(`vc-mobile-tab-${tabs[next].id}`);
    node?.focus();
  }
</script>

<!-- div, not <nav> — Svelte's a11y_no_noninteractive_element_to_interactive_role
     check rejects nav+role=tablist, and the W3C ARIA tabs pattern uses a div
     anyway (the role is the landmark, not the element). -->
<div class="vc-mobile-tab-bar" role="tablist" aria-label="Main navigation">
  {#each tabs as tab, idx (tab.id)}
    {@const Icon = tab.icon}
    {@const isActive = activeId === tab.id}
    <button
      type="button"
      role="tab"
      id={`vc-mobile-tab-${tab.id}`}
      aria-selected={isActive ? "true" : "false"}
      aria-controls={tab.controls}
      tabindex={tabIndex(tab.id, idx)}
      onclick={() => onSelect(tab.id)}
      onkeydown={(e) => onTabKeydown(e, idx)}
      class="vc-mobile-tab"
      class:vc-mobile-tab--active={isActive}
    >
      <span class="vc-mobile-tab-pill" class:vc-mobile-tab-pill--active={isActive}>
        <Icon size={20} strokeWidth={1.5} />
        <span class="vc-mobile-tab-label">{tab.label}</span>
      </span>
    </button>
  {/each}
</div>

<style>
  .vc-mobile-tab-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
    padding-bottom: env(safe-area-inset-bottom);
    display: flex;
    z-index: 40;
  }

  .vc-mobile-tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: var(--vc-hit-target, 44px);
    min-height: var(--vc-hit-target, 44px);
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    font-family: var(--vc-font-body);
    padding: 0;
  }

  .vc-mobile-tab--active {
    color: var(--color-accent);
  }

  .vc-mobile-tab-pill {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    border-radius: 8px;
    transition: background 150ms, color 150ms;
  }

  .vc-mobile-tab-pill--active {
    background: var(--color-accent-bg);
  }

  .vc-mobile-tab-label {
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
  }
</style>
