<script lang="ts">
  /**
   * Reading Mode pane (#63).
   *
   * Loads the tab's file via `readFile`, pipes it through the markdown-it
   * renderer, injects the sanitised HTML, and forwards wiki-link clicks as
   * the same `wiki-link-click` CustomEvent the CM6 plugin dispatches so
   * EditorPane's existing `handleWikiLinkClick` handler can navigate.
   *
   * Scroll position is persisted to `tab.readingScrollPos` separately from
   * the editor's `scrollPos`, so switching modes restores each view's last
   * position independently.
   */

  import { onMount, onDestroy } from "svelte";
  import { readFile } from "../../ipc/commands";
  import { renderMarkdownToHtml } from "./reading/markdownRenderer";
  import { toastStore } from "../../store/toastStore";
  import { tabStore } from "../../store/tabStore";
  import type { Tab } from "../../store/tabStore";

  interface Props {
    tab: Tab;
    isActive: boolean;
  }

  let { tab, isActive }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let html = $state<string>("");
  let loadError = $state<string | null>(null);

  // Track the tab id we last loaded for so switching tabs inside the same
  // pane re-loads even when the component is reused.
  let loadedForId: string | null = null;

  async function load(): Promise<void> {
    if (!tab) return;
    try {
      const content = await readFile(tab.filePath);
      html = renderMarkdownToHtml(content);
      loadError = null;
    } catch (err) {
      loadError = "Datei konnte nicht gelesen werden.";
      toastStore.push({ variant: "error", message: loadError });
    }
  }

  // Re-load whenever the tab id changes or this component becomes active
  // (mode switch from edit → read needs a fresh read so the reader shows
  // the current editor buffer saved to disk).
  $effect(() => {
    const id = tab.id;
    if (id !== loadedForId) {
      loadedForId = id;
      void load();
    }
  });

  // Save the current scroll position when this view deactivates (tab switch
  // or mode switch). We restore on activation in a subsequent $effect.
  let wasActive = false;
  $effect(() => {
    const nowActive = isActive;
    if (wasActive && !nowActive && containerEl) {
      tabStore.updateReadingScrollPos(tab.id, containerEl.scrollTop);
    }
    if (!wasActive && nowActive && containerEl) {
      // Restore after the HTML has been injected. The rAF gives the browser
      // a chance to lay out the freshly-rendered content first; without it
      // scrollTop silently clamps to 0 on the very first activation.
      const pos = tab.readingScrollPos ?? 0;
      requestAnimationFrame(() => {
        if (containerEl) containerEl.scrollTop = pos;
      });
    }
    wasActive = nowActive;
  });

  // Persist scroll on unmount too — covers closing the tab while in Reading
  // Mode, which otherwise would drop the scroll position.
  onDestroy(() => {
    if (isActive && containerEl) {
      tabStore.updateReadingScrollPos(tab.id, containerEl.scrollTop);
    }
  });

  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const anchor = target.closest("[data-wiki-target]") as HTMLElement | null;
    if (!anchor) return;
    event.preventDefault();
    const wikiTarget = anchor.getAttribute("data-wiki-target") ?? "";
    const resolved = anchor.getAttribute("data-wiki-resolved") === "true";
    // Reuse the same CustomEvent contract the CM6 wiki-link plugin dispatches
    // so EditorPane.handleWikiLinkClick handles navigation identically.
    containerEl?.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: wikiTarget, resolved },
      }),
    );
  }

  // Restore initial scroll after the first render when the tab opens directly
  // in Reading Mode (isActive was already true when the component mounted, so
  // the wasActive → active transition above wouldn't fire).
  onMount(() => {
    if (isActive && containerEl) {
      const pos = tab.readingScrollPos ?? 0;
      requestAnimationFrame(() => {
        if (containerEl) containerEl.scrollTop = pos;
      });
    }
    wasActive = isActive;
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="vc-reading-view"
  bind:this={containerEl}
  onclick={handleClick}
>
  {#if loadError}
    <div class="vc-reading-error">{loadError}</div>
  {:else}
    <!-- eslint-disable-next-line svelte/no-at-html-tags — HTML is sanitised by DOMPurify upstream -->
    <div class="vc-reading-content">{@html html}</div>
  {/if}
</div>

<style>
  .vc-reading-view {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 24px 48px 48px;
    background: var(--color-surface);
    color: var(--color-text);
    font-family: var(--vc-font-body, system-ui, -apple-system, sans-serif);
    font-size: var(--vc-font-size, 15px);
    line-height: 1.7;
    cursor: default;
    user-select: text;
  }

  .vc-reading-content {
    max-width: 720px;
    margin: 0 auto;
  }

  .vc-reading-error {
    padding: 24px;
    color: var(--color-error, #c0392b);
    text-align: center;
  }

  .vc-reading-content :global(h1),
  .vc-reading-content :global(h2),
  .vc-reading-content :global(h3),
  .vc-reading-content :global(h4),
  .vc-reading-content :global(h5),
  .vc-reading-content :global(h6) {
    margin: 1.4em 0 0.6em;
    line-height: 1.3;
    font-weight: 700;
    color: var(--color-text);
  }

  .vc-reading-content :global(h1) { font-size: 1.9em; border-bottom: 1px solid var(--color-border); padding-bottom: 0.3em; }
  .vc-reading-content :global(h2) { font-size: 1.5em; }
  .vc-reading-content :global(h3) { font-size: 1.25em; }
  .vc-reading-content :global(h4) { font-size: 1.1em; }

  .vc-reading-content :global(p) {
    margin: 0.8em 0;
  }

  .vc-reading-content :global(ul),
  .vc-reading-content :global(ol) {
    margin: 0.6em 0;
    padding-left: 1.6em;
  }

  .vc-reading-content :global(li) {
    margin: 0.2em 0;
  }

  .vc-reading-content :global(blockquote) {
    margin: 1em 0;
    padding: 0.2em 1em;
    border-left: 3px solid var(--color-accent);
    color: var(--color-text-muted);
    background: var(--color-accent-bg, rgba(0, 0, 0, 0.03));
  }

  .vc-reading-content :global(code) {
    font-family: var(--vc-font-mono, ui-monospace, monospace);
    font-size: 0.9em;
    padding: 1px 4px;
    background: var(--color-surface-alt, rgba(0, 0, 0, 0.06));
    border-radius: 3px;
  }

  .vc-reading-content :global(pre) {
    background: var(--color-surface-alt, rgba(0, 0, 0, 0.06));
    padding: 12px 14px;
    border-radius: 4px;
    overflow-x: auto;
    line-height: 1.45;
  }

  .vc-reading-content :global(pre code) {
    padding: 0;
    background: transparent;
    font-size: 0.88em;
  }

  .vc-reading-content :global(a) {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .vc-reading-content :global(.vc-reading-wikilink--resolved) {
    color: var(--color-accent);
  }

  .vc-reading-content :global(.vc-reading-wikilink--unresolved) {
    color: var(--color-text-muted);
    text-decoration: underline dashed;
  }

  .vc-reading-content :global(img),
  .vc-reading-content :global(.vc-reading-embed-img) {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0.6em 0;
    border-radius: 3px;
  }

  .vc-reading-content :global(.vc-reading-embed--unresolved) {
    display: inline-block;
    padding: 2px 6px;
    border: 1px dashed var(--color-border);
    color: var(--color-text-muted);
    border-radius: 3px;
    font-size: 0.9em;
  }

  .vc-reading-content :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
  }

  .vc-reading-content :global(th),
  .vc-reading-content :global(td) {
    border: 1px solid var(--color-border);
    padding: 6px 10px;
    text-align: left;
  }

  .vc-reading-content :global(hr) {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 1.6em 0;
  }

  .vc-reading-content :global(.vc-reading-task) {
    margin-right: 6px;
    transform: translateY(1px);
  }
</style>
