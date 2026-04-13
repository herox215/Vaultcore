<script lang="ts">
  import { tagsStore } from "../../store/tagsStore";
  import { searchStore } from "../../store/searchStore";
  import TagRow from "./TagRow.svelte";
  import type { TagUsage } from "../../types/tags";

  // Group into {parent → children} structure (single level of nesting only per D-03).
  interface TagTreeNode { full: string; display: string; count: number; children: TagTreeNode[]; }

  function buildTree(tags: readonly TagUsage[]): TagTreeNode[] {
    const byParent = new Map<string, TagTreeNode>();
    const flat: TagTreeNode[] = [];
    // First pass: all tags become nodes keyed by full name
    const nodes = tags.map((t) => ({ full: t.tag, display: t.tag.split("/").pop() ?? t.tag, count: t.count, children: [] as TagTreeNode[] }));
    for (const n of nodes) {
      const parts = n.full.split("/");
      if (parts.length === 1) {
        byParent.set(n.full, n);
        flat.push(n);
      } else {
        const parentName = parts[0];
        let parentNode = byParent.get(parentName);
        if (!parentNode) {
          parentNode = { full: parentName, display: parentName, count: 0, children: [] };
          byParent.set(parentName, parentNode);
          flat.push(parentNode);
        }
        parentNode.children.push({ ...n, display: parts.slice(1).join("/") });
      }
    }
    // Sort parents alphabetically; sort children alphabetically within each parent
    flat.sort((a, b) => a.display.localeCompare(b.display));
    for (const p of flat) p.children.sort((a, b) => a.display.localeCompare(b.display));
    return flat;
  }

  const tree = $derived(buildTree($tagsStore.tags));
  let expandedParents = $state<Set<string>>(new Set());

  function toggleParent(full: string): void {
    const next = new Set(expandedParents);
    if (next.has(full)) next.delete(full); else next.add(full);
    expandedParents = next;
  }

  function runSearchFor(fullTag: string): void {
    // BUG-05.1: previously only setActiveTab + setQuery, so the SearchPanel
    // would show the query in the input but never actually run. runSearch
    // switches the tab, sets the query, AND dispatches search_fulltext.
    void searchStore.runSearch("#" + fullTag);
  }
</script>

<div class="vc-tags-panel" role="tree" aria-label="Tags-Bereich">
  {#if $tagsStore.loading}
    <div class="vc-tags-state">Lädt …</div>
  {:else if $tagsStore.error}
    <div class="vc-tags-state vc-tags-state--error">{$tagsStore.error}</div>
  {:else if $tagsStore.tags.length === 0}
    <div class="vc-tags-empty">
      <p class="vc-tags-empty-title">Keine Tags</p>
      <p class="vc-tags-empty-body">Erstelle Notizen mit #Tags, um sie hier zu sehen.</p>
    </div>
  {:else}
    <div class="vc-tags-scroll">
      {#each tree as parent (parent.full)}
        <TagRow
          label={parent.full}
          displayName={parent.display}
          count={parent.count + parent.children.reduce((s, c) => s + c.count, 0)}
          depth={0}
          hasChildren={parent.children.length > 0}
          expanded={expandedParents.has(parent.full)}
          onToggle={() => toggleParent(parent.full)}
          onClick={() => runSearchFor(parent.full)}
        />
        {#if expandedParents.has(parent.full)}
          {#each parent.children as child (child.full)}
            <TagRow
              label={child.full}
              displayName={child.display}
              count={child.count}
              depth={1}
              hasChildren={false}
              expanded={false}
              onToggle={() => {}}
              onClick={() => runSearchFor(child.full)}
            />
          {/each}
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .vc-tags-panel { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .vc-tags-scroll { flex: 1; overflow-y: auto; }
  .vc-tags-state { padding: 24px 16px; color: var(--color-text-muted); font-size: 14px; }
  .vc-tags-state--error { color: var(--color-error); }
  .vc-tags-empty { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding-top: 40%; gap: 8px; text-align: center; }
  .vc-tags-empty-title { font-size: 14px; font-weight: 600; color: var(--color-text); margin: 0; }
  .vc-tags-empty-body { font-size: 12px; color: var(--color-text-muted); margin: 0; max-width: 220px; }
</style>
