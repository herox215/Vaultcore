<script lang="ts">
  import { Check } from "lucide-svelte";
  import type { SortBy } from "../../lib/treeState";

  interface Props {
    value: SortBy;
    onSelect: (next: SortBy) => void;
    onDismiss: () => void;
  }
  let { value, onSelect, onDismiss }: Props = $props();

  const OPTIONS: Array<{ id: SortBy; label: string }> = [
    { id: "name", label: "Name" },
    { id: "modified", label: "Geändert" },
    { id: "created", label: "Erstellt" },
  ];

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />
<div class="vc-sort-menu" role="menu" aria-label="Sortierung">
  {#each OPTIONS as opt (opt.id)}
    <button
      type="button"
      class="vc-sort-menu-item"
      class:vc-sort-menu-item--active={opt.id === value}
      role="menuitemradio"
      aria-checked={opt.id === value}
      onclick={() => onSelect(opt.id)}
    >
      <span class="vc-sort-menu-label">{opt.label}</span>
      {#if opt.id === value}<Check size={14} />{/if}
    </button>
  {/each}
</div>

<style>
  .vc-sort-menu {
    position: absolute;
    top: 36px;
    right: 8px;
    width: 180px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 150;
    padding: 4px 0;
  }

  .vc-sort-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 32px;
    padding: 0 16px;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
  }

  .vc-sort-menu-item:hover {
    background: color-mix(in srgb, var(--color-accent-bg) 50%, transparent);
  }

  .vc-sort-menu-item--active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-sort-menu-label {
    flex: 1;
  }
</style>
