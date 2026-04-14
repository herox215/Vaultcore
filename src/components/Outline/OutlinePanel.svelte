<script lang="ts">
  import { ChevronDown, ChevronRight } from "lucide-svelte";
  import { EditorView } from "@codemirror/view";
  import { activeViewStore } from "../../store/activeViewStore";
  import { extractHeadingsFromState } from "../../lib/headings";
  import type { Heading } from "../../lib/headings";
  import OutlineRow from "./OutlineRow.svelte";

  const STORAGE_KEY_COLLAPSED = "vaultcore-outline-collapsed";

  function loadCollapsed(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY_COLLAPSED) === "true";
    } catch {
      return false;
    }
  }

  let collapsed = $state<boolean>(loadCollapsed());
  let activeIndex = $state<number>(-1);

  // Reactive view + doc version — same pattern as OutgoingLinksPanel.
  let view = $derived($activeViewStore.view);
  let version = $derived($activeViewStore.docVersion);

  // Recompute headings on every doc change or active-view switch.
  let headings = $derived.by<Heading[]>(() => {
    void version;
    if (!view) return [];
    return extractHeadingsFromState(view.state);
  });

  // ── Scroll listener for active-heading tracking ──────────────────────────

  let scrollCleanup: (() => void) | null = null;

  function computeActiveIndex(currentView: EditorView, currentHeadings: Heading[]): number {
    if (currentHeadings.length === 0) return -1;
    const vpFrom = currentView.viewport.from;
    const anchorLine = currentView.state.doc.lineAt(Math.min(vpFrom + 50, currentView.state.doc.length));
    const anchorPos = anchorLine.from;

    let best = 0;
    for (let i = 0; i < currentHeadings.length; i++) {
      const h = currentHeadings[i];
      if (h !== undefined && h.from <= anchorPos) {
        best = i;
      }
    }
    return best;
  }

  function attachScrollListener(currentView: EditorView): () => void {
    const scrollEl = currentView.scrollDOM;
    const handler = () => {
      activeIndex = computeActiveIndex(currentView, headings);
    };
    scrollEl.addEventListener("scroll", handler, { passive: true });
    // Compute immediately on attach.
    activeIndex = computeActiveIndex(currentView, headings);
    return () => scrollEl.removeEventListener("scroll", handler);
  }

  // Watch the active view — attach/detach scroll listener as it changes.
  $effect(() => {
    if (scrollCleanup) {
      scrollCleanup();
      scrollCleanup = null;
    }
    if (view) {
      scrollCleanup = attachScrollListener(view);
    } else {
      activeIndex = -1;
    }
    return () => {
      if (scrollCleanup) {
        scrollCleanup();
        scrollCleanup = null;
      }
    };
  });

  // Re-evaluate active heading whenever headings list is rebuilt.
  $effect(() => {
    void headings;
    if (view) {
      activeIndex = computeActiveIndex(view, headings);
    }
  });

  // ── Collapsed toggle ─────────────────────────────────────────────────────

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));
    } catch {
      /* ignore */
    }
  }

  // ── Click-to-jump ────────────────────────────────────────────────────────

  function handleClick(entry: Heading): void {
    if (!view) return;
    view.dispatch({
      selection: { anchor: entry.from },
      effects: EditorView.scrollIntoView(entry.from, { y: "start" }),
    });
    view.focus();
  }
</script>

<div class="vc-outline-panel" role="complementary" aria-label="Outline">
  <button
    type="button"
    class="vc-outline-header"
    aria-expanded={!collapsed}
    onclick={toggleCollapsed}
  >
    {#if collapsed}
      <ChevronRight size={14} />
    {:else}
      <ChevronDown size={14} />
    {/if}
    <span class="vc-outline-label">Outline</span>
    {#if headings.length > 0}
      <span class="vc-outline-count">{headings.length}</span>
    {/if}
  </button>

  {#if !collapsed}
    <div class="vc-outline-body">
      {#if !view}
        <div class="vc-outline-empty">Keine Datei geöffnet.</div>
      {:else if headings.length === 0}
        <div class="vc-outline-empty">No headings</div>
      {:else}
        <div role="list">
          {#each headings as entry, i (entry.from)}
            <div role="listitem">
              <OutlineRow
                {entry}
                active={i === activeIndex}
                onClick={handleClick}
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .vc-outline-panel {
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
  }
  .vc-outline-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 16px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    width: 100%;
    text-align: left;
  }
  .vc-outline-header:hover {
    color: var(--color-accent);
  }
  .vc-outline-label {
    font-size: 12px;
    font-weight: 600;
    flex: 1;
  }
  .vc-outline-count {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-muted);
  }
  .vc-outline-body {
    flex: 0 0 auto;
    max-height: 40vh;
    overflow-y: auto;
  }
  .vc-outline-empty {
    padding: 24px 16px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }
</style>
