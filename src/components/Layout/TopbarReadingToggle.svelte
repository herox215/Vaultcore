<script lang="ts">
  /**
   * #388 — Mobile-only Reading Mode toggle in the editor topbar.
   *
   * Visible only when:
   *   - viewport.mode === "mobile", AND
   *   - there is an active tab, AND
   *   - that tab supports Reading Mode (markdown / undefined viewer; not
   *     graph / image / unsupported / text / canvas).
   *
   * Click flips the active tab's viewMode via `tabStore.toggleViewMode`.
   *
   * Why a dedicated component instead of inlining in VaultLayout:
   *   - Keeps VaultLayout free of yet-more reactive subscriptions.
   *   - Single click path through `tabSupportsReading()` matches the guard
   *     in `VaultLayout.toggleActiveReadingMode` (Boy Scout fix from plan v3).
   *
   * Breadcrumbs self-hides on mobile so the two never co-render.
   */
  import { BookOpen, Pencil } from "lucide-svelte";
  import { tabStore } from "../../store/tabStore";
  import { viewportStore } from "../../store/viewportStore";
  import { tabSupportsReading } from "../../lib/tabKind";
  import type { Tab, TabViewMode } from "../../store/tabStore";

  // Auto-subscribe via `$store` syntax so reactive readers stay inside
  // Svelte's tracking context. The expressions below depend on the store
  // values directly — `$derived` then re-evaluates on every store emission.
  const activeTab: Tab | null = $derived(
    $tabStore.activeTabId
      ? $tabStore.tabs.find((t) => t.id === $tabStore.activeTabId) ?? null
      : null,
  );

  const supports = $derived(activeTab !== null && tabSupportsReading(activeTab));
  const visible = $derived(
    $viewportStore.mode === "mobile" && supports && activeTab !== null,
  );
  const mode: TabViewMode = $derived(
    activeTab !== null ? (activeTab.viewMode ?? "edit") : "edit",
  );

  function handleClick() {
    if (!activeTab) return;
    if (!tabSupportsReading(activeTab)) return;
    tabStore.toggleViewMode(activeTab.id);
  }
</script>

{#if visible}
  <button
    type="button"
    class="vc-topbar-reading-toggle"
    class:vc-topbar-reading-toggle--read={mode === "read"}
    data-vc-topbar-reading-toggle
    data-mode={mode}
    onclick={handleClick}
    aria-pressed={mode === "read"}
    aria-label={mode === "read" ? "Bearbeitungsmodus" : "Lesemodus"}
    title={mode === "read" ? "Bearbeitungsmodus" : "Lesemodus"}
  >
    {#if mode === "read"}
      <Pencil size={16} />
    {:else}
      <BookOpen size={16} />
    {/if}
  </button>
{/if}

<style>
  .vc-topbar-reading-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    /* #385 hit-target token bumps to 44px under (pointer: coarse). */
    min-width: var(--vc-hit-target, 32px);
    min-height: var(--vc-hit-target, 32px);
    padding: 0;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text-muted);
  }

  .vc-topbar-reading-toggle:hover:not(.vc-topbar-reading-toggle--read) {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-topbar-reading-toggle--read {
    background: var(--color-accent);
    color: var(--color-surface);
  }

  .vc-topbar-reading-toggle--read:hover {
    filter: brightness(1.1);
  }

  .vc-topbar-reading-toggle:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
</style>
