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
  import { resolveAttachmentSrc, releaseAttachmentSrc } from "./attachmentSource";
  import { toastStore } from "../../store/toastStore";
  import { tabStore } from "../../store/tabStore";
  import type { Tab } from "../../store/tabStore";
  import { vaultStore } from "../../store/vaultStore";
  import { tagsStore } from "../../store/tagsStore";
  import { bookmarksStore } from "../../store/bookmarksStore";
  import { resolvedLinksStore } from "../../store/resolvedLinksStore";
  import { noteContentCacheVersion } from "../../lib/noteContentCache";
  import { titleFromPath } from "../../lib/templateScope";

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

  // Generation token guards against stale-write races: every call to `load()`
  // takes the current value of `gen`, and only writes `html` / `loadError` if
  // its token is still current when the async `readFile` resolves. Without
  // this, a slow read for tab A that's still in flight when the user switches
  // to tab B can overwrite tab B's rendered HTML with tab A's content.
  let gen = 0;
  // Pending-reload latch: when multiple store subscriptions fire in the same
  // frame (e.g. rename bumps vaultStore + noteContentCacheVersion + tagsStore
  // at once), coalesce them into a single microtask-scheduled reload.
  let reloadPending = false;

  // #357: track blob URLs we handed to `<img data-vc-encrypted-abs>`
  // so `onDestroy` / tab-switch revokes them — otherwise every rendered
  // encrypted-image leaks its decrypted bytes into the browser blob
  // store for the lifetime of the process.
  let blobUrls: string[] = [];
  function releaseAllBlobUrls(): void {
    for (const url of blobUrls) releaseAttachmentSrc(url);
    blobUrls = [];
  }

  async function load(): Promise<void> {
    if (!tab) return;
    const token = ++gen;
    const path = tab.filePath;
    try {
      const content = await readFile(path);
      if (token !== gen) return;
      releaseAllBlobUrls();
      html = renderMarkdownToHtml(content, titleFromPath(path));
      loadError = null;
    } catch (err) {
      if (token !== gen) return;
      const message = "Datei konnte nicht gelesen werden.";
      // Suppress repeated toasts while the error condition persists — a
      // bulk rename or mid-rename watcher burst emits many store ticks per
      // frame, and raising a toast on every one of them floods the UI.
      const shouldToast = loadError !== message;
      loadError = message;
      if (shouldToast) {
        toastStore.push({ variant: "error", message: message });
      }
    }
  }

  onDestroy(() => {
    releaseAllBlobUrls();
  });

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

  // #357: after every HTML re-render, hydrate the `data-vc-encrypted-abs`
  // markers the markdown renderer emitted for attachments inside
  // encrypted folders. Plain-vault images already have their asset://
  // src baked in — we only touch the encrypted ones. The blob URLs are
  // tracked so a tab switch / destroy revokes them.
  $effect(() => {
    // React to `html` reassignment so a fresh render triggers hydration.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    html;
    if (!containerEl) return;
    const pending = containerEl.querySelectorAll<HTMLImageElement>(
      "img[data-vc-encrypted-abs]",
    );
    for (const img of Array.from(pending)) {
      const abs = img.getAttribute("data-vc-encrypted-abs");
      if (!abs) continue;
      img.removeAttribute("data-vc-encrypted-abs");
      const result = resolveAttachmentSrc(abs);
      if (typeof result === "string") {
        img.src = result;
      } else {
        void result.then((resolved) => {
          if (resolved) {
            img.src = resolved;
            blobUrls.push(resolved);
          }
        });
      }
    }
  });

  // #321 — Reading Mode must re-render when the data a `{{ ... }}` template
  // expression reads over changes on disk, otherwise a template like
  // `{{vault.notes.where(n => n.content.contains("X"))}}` would stay frozen
  // with whatever the vault looked like when the tab opened. Subscribe to the
  // same stores the CM6 live-preview plugin watches (vaultStore / tagsStore /
  // bookmarksStore / noteContentCacheVersion) and re-read the file on any
  // tick. The svelte subscribe contract invokes the callback synchronously
  // with the current value, so a `ready` latch suppresses the initial burst
  // that would otherwise double-load on mount. `queueMicrotask` coalesces
  // bursts that cross multiple stores (rename / delete / cache version bump
  // commonly fire all four in the same frame) into one `readFile` + render
  // cycle instead of four.
  onMount(() => {
    let ready = false;
    const trigger = (): void => {
      if (!ready) return;
      if (loadedForId === null) return;
      if (reloadPending) return;
      reloadPending = true;
      queueMicrotask(() => {
        reloadPending = false;
        void load();
      });
    };
    // #309: re-read + re-render when the resolved-links map becomes fresh so
    // `[[New Note]]` rendered from a `{{ ... }}` template expression flips
    // from unresolved to resolved without a manual tab reload. Guard on
    // `readyToken` only — firing on `requestToken` would re-render against
    // the still-stale map.
    let prevReadyToken: string | null = null;
    const unsubs: Array<() => void> = [
      vaultStore.subscribe(trigger),
      tagsStore.subscribe(trigger),
      bookmarksStore.subscribe(trigger),
      noteContentCacheVersion.subscribe(trigger),
      resolvedLinksStore.subscribe((state) => {
        if (state.readyToken && state.readyToken !== prevReadyToken) {
          prevReadyToken = state.readyToken;
          trigger();
        }
      }),
    ];
    ready = true;
    // Teardown lives next to the subscriptions rather than in a separate
    // `onDestroy` so a future reader sees the full lifecycle in one block.
    // The scroll-persist cleanup below uses the same pattern.
    return () => {
      for (const u of unsubs) u();
    };
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

  // Restore initial scroll after the first render when the tab opens directly
  // in Reading Mode (isActive was already true when the component mounted, so
  // the wasActive → active transition above wouldn't fire). Also persists
  // scroll on unmount — covers closing the tab while in Reading Mode, which
  // otherwise would drop the scroll position. Teardown is returned as the
  // onMount cleanup to keep the whole lifecycle in one block instead of
  // splitting between onMount + a separate onDestroy.
  onMount(() => {
    if (isActive && containerEl) {
      const pos = tab.readingScrollPos ?? 0;
      requestAnimationFrame(() => {
        if (containerEl) containerEl.scrollTop = pos;
      });
    }
    wasActive = isActive;
    return () => {
      if (isActive && containerEl) {
        tabStore.updateReadingScrollPos(tab.id, containerEl.scrollTop);
      }
    };
  });

  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Wiki-link — forward as a CustomEvent so EditorPane owns navigation.
    const wikiAnchor = target.closest("[data-wiki-target]") as HTMLElement | null;
    if (wikiAnchor) {
      event.preventDefault();
      const wikiTarget = wikiAnchor.getAttribute("data-wiki-target") ?? "";
      const resolved = wikiAnchor.getAttribute("data-wiki-resolved") === "true";
      containerEl?.dispatchEvent(
        new CustomEvent("wiki-link-click", {
          bubbles: true,
          detail: { target: wikiTarget, resolved },
        }),
      );
      return;
    }

    // In-page anchor (table-of-contents style): `<a href="#heading-slug">`.
    // Scroll the reading container to the target element. Using the plain
    // browser default would scroll the entire window and leave the inner
    // container untouched, since the anchor lives inside an absolutely-
    // positioned scroll area.
    const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("#") || href.length < 2) return;
    const id = decodeURIComponent(href.slice(1));
    const targetEl = containerEl?.querySelector(
      `[id="${CSS.escape(id)}"]`,
    ) as HTMLElement | null;
    if (!targetEl || !containerEl) return;
    event.preventDefault();
    // offsetTop is relative to the nearest positioned ancestor — the content
    // wrapper sits inside the scroll container, so subtract the container's
    // own offsetTop from the target's offsetTop via getBoundingClientRect.
    const containerTop = containerEl.getBoundingClientRect().top;
    const targetTop = targetEl.getBoundingClientRect().top;
    containerEl.scrollTop += targetTop - containerTop - 8;
  }
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
    max-width: var(--vc-editor-max-width, 720px);
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
