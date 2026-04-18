<script lang="ts">
  // Small cursor-anchored colour picker popover (#166). Mirrors the geometry
  // of `ContextMenu`: an overlay (click-to-close) plus a fixed-position card
  // with a hex swatch grid, a native `<input type="color">` for custom picks,
  // and a Clear button. `onChange(null)` signals the consumer to delete its
  // colour field so any CSS fallback re-applies.

  import { tick, untrack } from "svelte";

  interface Props {
    open: boolean;
    x: number;
    y: number;
    value?: string | null;
    onChange: (value: string | null) => void;
    onClose: () => void;
  }

  let { open, x, y, value = null, onChange, onClose }: Props = $props();

  const SWATCHES = [
    "#ef4444", "#f97316", "#eab308", "#22c55e",
    "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
  ];

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

  function onSwatch(c: string) {
    onChange(c);
    onClose();
  }

  function onCustomInput(e: Event) {
    onChange((e.target as HTMLInputElement).value);
  }

  function onClear() {
    onChange(null);
    onClose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-color-overlay"
    onclick={onClose}
    oncontextmenu={(e) => { e.preventDefault(); onClose(); }}
    role="presentation"
  ></div>
  <div
    bind:this={menuEl}
    class="vc-color-picker"
    style="top: {adjustedY}px; left: {adjustedX}px;"
    role="dialog"
    aria-label="Farbe wählen"
  >
    <div class="vc-color-swatches">
      {#each SWATCHES as c (c)}
        <button
          type="button"
          class="vc-color-swatch"
          class:vc-color-swatch-active={value === c}
          style:background-color={c}
          aria-label={`Farbe ${c}`}
          data-color={c}
          onclick={() => onSwatch(c)}
        ></button>
      {/each}
    </div>
    <div class="vc-color-row">
      <input
        type="color"
        class="vc-color-custom"
        value={value ?? "#3b82f6"}
        oninput={onCustomInput}
        aria-label="Benutzerdefinierte Farbe"
      />
      <button
        type="button"
        class="vc-color-clear"
        onclick={onClear}
      >Clear</button>
    </div>
  </div>
{/if}

<style>
  .vc-color-overlay {
    position: fixed;
    inset: 0;
    z-index: 199;
  }

  .vc-color-picker {
    position: fixed;
    z-index: 200;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 160px;
  }

  .vc-color-swatches {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }

  .vc-color-swatch {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    cursor: pointer;
    padding: 0;
  }

  .vc-color-swatch-active {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .vc-color-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .vc-color-custom {
    flex: 1;
    height: 28px;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    background: none;
  }

  .vc-color-clear {
    font-size: 12px;
    padding: 4px 10px;
    background: none;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
  }

  .vc-color-clear:hover {
    background: var(--color-accent-bg);
  }
</style>
