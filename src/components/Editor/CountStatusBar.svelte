<script lang="ts">
  // Thin status bar at the bottom of an editor pane showing live word and
  // character counts. Reads per-pane counts from `countsStore`, which is
  // published by the CM6 `countsPlugin` on docChanged/selectionSet (100ms
  // debounce for doc edits, immediate for selection changes).
  //
  // Rendered by EditorPane only when a tab is open in that pane, so the
  // bar disappears on the "No file open" placeholder.

  import { onDestroy } from "svelte";
  import { countsStore, type PaneId, type PaneCounts } from "../../store/countsStore";

  let { paneId }: { paneId: PaneId } = $props();

  let counts = $state<PaneCounts | null>(null);
  const unsub = countsStore.subscribe((s) => { counts = s[paneId]; });
  onDestroy(() => unsub());

  const label = $derived.by(() => {
    if (!counts) return "";
    const { words, characters, selection } = counts;
    const wordsLabel = words === 1 ? "word" : "words";
    const charsLabel = characters === 1 ? "character" : "characters";
    const suffix = selection ? " selected" : "";
    return `${words.toLocaleString()} ${wordsLabel} · ${characters.toLocaleString()} ${charsLabel}${suffix}`;
  });
</script>

{#if counts}
  <div class="vc-count-status-bar" role="status" aria-live="polite">
    <span class="vc-count-status-text">{label}</span>
  </div>
{/if}

<style>
  .vc-count-status-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    height: 22px;
    padding: 0 10px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text-muted);
    font-size: 12px;
    flex-shrink: 0;
    user-select: none;
  }

  .vc-count-status-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
