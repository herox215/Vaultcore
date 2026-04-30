<script lang="ts">
  import { ChevronRight } from "lucide-svelte";

  interface Props {
    label: string;               // tag text WITHOUT leading '#' (e.g. "rust" or "parent/child")
    displayName: string;         // rendered portion ("rust" for flat, "child" for nested child)
    count: number;
    depth: 0 | 1;                // 0 = parent/flat, 1 = nested child
    hasChildren: boolean;        // if true, render chevron at left
    expanded: boolean;
    onToggle: () => void;        // no-op if hasChildren === false
    onClick: () => void;         // triggers search
  }
  let { label, displayName, count, depth, hasChildren, expanded, onToggle, onClick }: Props = $props();
</script>

<div
  class="vc-tag-row"
  class:vc-tag-row--child={depth === 1}
  role="treeitem"
  aria-selected="false"
  aria-level={depth + 1}
  aria-expanded={hasChildren ? expanded : undefined}
  aria-label={`${displayName} — ${count} Notizen`}
>
  {#if hasChildren}
    <button
      type="button"
      class="vc-tag-chevron"
      class:vc-tag-chevron--expanded={expanded}
      onclick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-label={expanded ? "Einklappen" : "Ausklappen"}
    >
      <ChevronRight size={12} />
    </button>
  {:else}
    <span class="vc-tag-chevron-spacer"></span>
  {/if}
  <button type="button" class="vc-tag-label" onclick={onClick}>
    <span class="vc-tag-name">#{displayName}</span>
    <span class="vc-tag-count">({count})</span>
  </button>
</div>

<style>
  /* #385 — desktop fallback preserves the 28px min-height; coarse → 44px. */
  .vc-tag-row { display: flex; align-items: center; min-height: var(--vc-hit-target, 28px); padding: 0 16px; }
  .vc-tag-row--child { padding-left: 32px; }
  .vc-tag-row:hover { background: var(--color-accent-bg); }
  .vc-tag-chevron, .vc-tag-chevron-spacer { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--color-text-muted); cursor: pointer; transition: transform 120ms ease; }
  .vc-tag-chevron--expanded :global(svg) { transform: rotate(90deg); }
  .vc-tag-label { flex: 1; display: flex; align-items: center; justify-content: space-between; background: transparent; border: none; color: var(--color-text); cursor: pointer; padding: 0 0 0 4px; font: inherit; text-align: left; }
  .vc-tag-name { font-size: 14px; font-weight: 400; }
  .vc-tag-count { font-size: 12px; font-weight: 400; color: var(--color-text-muted); }
</style>
