<script lang="ts">
  import { FileText, ListTree, ArrowUpRight, ArrowDownLeft } from "lucide-svelte";
  import BacklinksPanel from "../Backlinks/BacklinksPanel.svelte";
  import OutgoingLinksPanel from "../OutgoingLinks/OutgoingLinksPanel.svelte";
  import OutlinePanel from "../Outline/OutlinePanel.svelte";
  import PropertiesPanel from "../Properties/PropertiesPanel.svelte";

  // Obsidian-style tabbed right sidebar: only one panel visible at a time, the
  // active panel takes the full sidebar height.
  const STORAGE_KEY = "vaultcore-right-sidebar-tab";
  type Tab = "properties" | "outline" | "outgoing" | "backlinks";
  const TAB_IDS: readonly Tab[] = [
    "properties",
    "outline",
    "outgoing",
    "backlinks",
  ] as const;

  function loadTab(): Tab {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v && (TAB_IDS as readonly string[]).includes(v)) return v as Tab;
    } catch {
      /* ignore */
    }
    return "properties";
  }

  let activeTab = $state<Tab>(loadTab());

  function setTab(t: Tab): void {
    activeTab = t;
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }
</script>

<div class="vc-right-sidebar">
  <div class="vc-right-tabs" role="tablist" aria-label="Right sidebar panels">
    <button
      type="button"
      class="vc-right-tab"
      class:vc-right-tab--active={activeTab === "properties"}
      role="tab"
      aria-selected={activeTab === "properties"}
      aria-label="Properties"
      title="Properties"
      onclick={() => setTab("properties")}
    >
      <FileText size={14} strokeWidth={1.75} />
    </button>
    <button
      type="button"
      class="vc-right-tab"
      class:vc-right-tab--active={activeTab === "outline"}
      role="tab"
      aria-selected={activeTab === "outline"}
      aria-label="Outline"
      title="Outline"
      onclick={() => setTab("outline")}
    >
      <ListTree size={14} strokeWidth={1.75} />
    </button>
    <button
      type="button"
      class="vc-right-tab"
      class:vc-right-tab--active={activeTab === "outgoing"}
      role="tab"
      aria-selected={activeTab === "outgoing"}
      aria-label="Outgoing Links"
      title="Outgoing Links"
      onclick={() => setTab("outgoing")}
    >
      <ArrowUpRight size={14} strokeWidth={1.75} />
    </button>
    <button
      type="button"
      class="vc-right-tab"
      class:vc-right-tab--active={activeTab === "backlinks"}
      role="tab"
      aria-selected={activeTab === "backlinks"}
      aria-label="Backlinks"
      title="Backlinks"
      onclick={() => setTab("backlinks")}
    >
      <ArrowDownLeft size={14} strokeWidth={1.75} />
    </button>
  </div>

  <div class="vc-right-tab-content" role="tabpanel">
    {#if activeTab === "properties"}
      <PropertiesPanel />
    {:else if activeTab === "outline"}
      <OutlinePanel />
    {:else if activeTab === "outgoing"}
      <OutgoingLinksPanel />
    {:else if activeTab === "backlinks"}
      <BacklinksPanel />
    {/if}
  </div>
</div>

<style>
  .vc-right-sidebar {
    height: 100%;
    overflow: hidden;
    background: var(--color-bg);
    display: flex;
    flex-direction: column;
  }
  .vc-right-tabs {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  .vc-right-tab {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 36px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    border-bottom: 2px solid transparent;
    padding: 0;
  }
  .vc-right-tab:hover {
    color: var(--color-accent);
  }
  .vc-right-tab--active {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }
  .vc-right-tab-content {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* Each panel fills the tab content area */
  .vc-right-tab-content > :global(*) {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
</style>
