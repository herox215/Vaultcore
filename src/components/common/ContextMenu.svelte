<script lang="ts">
  // Shared cursor-anchored popover menu (#164).
  //
  // Renders an overlay (click-to-close) and the menu itself, positioned at
  // viewport-fixed (x, y). On mount the menu measures its own rect and shifts
  // left / up when it would overflow the viewport — so right-clicks near the
  // screen edge still surface the whole menu.
  //
  // Closing rules: click anywhere on the overlay, or press Escape. The Escape
  // listener is attached to `window` only while the menu is open and stops
  // propagation so parents (e.g. canvas's edit-mode cancel) don't also react.
  //
  // Consumers own the items: pass them as the `children` snippet with whatever
  // buttons / separators they need. Item classes `.vc-context-item` and
  // `.vc-context-item--danger` are styled here so consumers can stay terse.

  import { tick, untrack, type Snippet } from "svelte";

  interface Props {
    open: boolean;
    x: number;
    y: number;
    onClose: () => void;
    children: Snippet;
  }

  let { open, x, y, onClose, children }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let adjustedX = $state(untrack(() => x));
  let adjustedY = $state(untrack(() => y));

  $effect(() => {
    if (!open) return;
    adjustedX = x;
    adjustedY = y;
    void (async () => {
      await tick();
      if (!menuEl) return;
      const rect = menuEl.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (x + rect.width > vw) adjustedX = Math.max(0, vw - rect.width - 4);
      if (y + rect.height > vh) adjustedY = Math.max(0, vh - rect.height - 4);
    })();
  });

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-context-overlay"
    onclick={onClose}
    oncontextmenu={(e) => { e.preventDefault(); onClose(); }}
    role="presentation"
  ></div>
  <div
    bind:this={menuEl}
    class="vc-context-menu"
    style="top: {adjustedY}px; left: {adjustedX}px;"
    role="menu"
  >
    {@render children()}
  </div>
{/if}

<style>
  .vc-context-overlay {
    position: fixed;
    inset: 0;
    z-index: 199;
  }

  .vc-context-menu {
    position: fixed;
    z-index: 200;
    min-width: 180px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    padding: 4px 0;
  }

  :global(.vc-context-item) {
    display: block;
    width: 100%;
    padding: 6px 12px;
    font-size: 14px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
    /* #385 — fallback `auto` = no min-height constraint (initial value), so
       desktop sizing stays padding-driven as before; coarse → 44px. Block
       display kept; on coarse the text sits at the top of the taller hit
       area until #386 polishes it. */
    min-height: var(--vc-hit-target, auto);
  }

  :global(.vc-context-item:hover),
  :global(.vc-context-item:focus-visible) {
    background: var(--color-accent-bg);
    outline: none;
  }

  :global(.vc-context-item--danger) {
    color: var(--color-error);
  }

  :global(.vc-context-separator) {
    height: 1px;
    background: var(--color-border);
    margin: 4px 0;
  }
</style>
