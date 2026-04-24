<script lang="ts">
  // #362: shape picker strip. Stateless presentational component — the
  // parent decides where to render it (inline inside the canvas context
  // menu) and what to do on pick (create a new shaped text node, or
  // re-shape an existing one). Keyboard-first to match the rest of the
  // app: ArrowDown/Up to navigate the list, Enter/Space to confirm, and
  // ArrowLeft from the first row to back out of the picker without
  // closing the whole menu.

  import { tick } from "svelte";
  import {
    CANVAS_SHAPES,
    type CanvasShape,
  } from "../../lib/canvas/types";

  interface Props {
    value: CanvasShape;
    onPick: (shape: CanvasShape) => void;
    /** ArrowLeft on the first row / Escape — closes the picker without
     *  making a selection. Parent typically refocuses the trigger row. */
    onCancel?: () => void;
    /** When true, focus the row matching `value` on mount. */
    autoFocus?: boolean;
  }

  let { value, onPick, onCancel, autoFocus = false }: Props = $props();

  // Pretty labels mirroring the shape names the user sees in the UI. Kept
  // here (not in types.ts) because they are a UI concern — the types
  // module is framework-free.
  const LABELS: Record<CanvasShape, string> = {
    "rounded-rectangle": "Rounded rectangle",
    rectangle: "Rectangle",
    ellipse: "Ellipse",
    diamond: "Diamond",
    triangle: "Triangle",
  };

  let rowEls = $state<(HTMLButtonElement | null)[]>(
    Array(CANVAS_SHAPES.length).fill(null),
  );

  function focusRow(index: number): void {
    const clamped = Math.max(0, Math.min(CANVAS_SHAPES.length - 1, index));
    rowEls[clamped]?.focus();
  }

  // Focus the initially selected row on mount so keyboard nav starts
  // from the shape the user currently has. Done via `tick` so the bind:
  // refs have populated before we try to focus.
  $effect(() => {
    if (!autoFocus) return;
    void (async () => {
      await tick();
      const idx = CANVAS_SHAPES.indexOf(value);
      focusRow(idx >= 0 ? idx : 0);
    })();
  });

  function currentIndex(): number {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement)) return -1;
    return rowEls.indexOf(active);
  }

  function onKey(e: KeyboardEvent, index: number): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      focusRow(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      focusRow(index - 1);
    } else if (e.key === "ArrowLeft") {
      if (index === 0) {
        // Back out of the picker without closing the parent menu.
        e.preventDefault();
        e.stopPropagation();
        onCancel?.();
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const shape = CANVAS_SHAPES[index];
      if (shape) onPick(shape);
    }
  }
</script>

<div class="vc-shape-picker" role="radiogroup" aria-label="Node shape">
  {#each CANVAS_SHAPES as shape, i (shape)}
    <button
      bind:this={rowEls[i]}
      type="button"
      class="vc-shape-picker-row"
      class:vc-shape-picker-row--selected={shape === value}
      role="radio"
      aria-checked={shape === value}
      aria-label={LABELS[shape]}
      data-shape={shape}
      onclick={(e) => { e.stopPropagation(); onPick(shape); }}
      onkeydown={(e) => onKey(e, i)}
    >
      <svg
        class="vc-shape-picker-icon"
        viewBox="0 0 20 20"
        aria-hidden="true"
        focusable="false"
      >
        {#if shape === "rounded-rectangle"}
          <rect x="2" y="5" width="16" height="10" rx="3" />
        {:else if shape === "rectangle"}
          <rect x="2" y="5" width="16" height="10" />
        {:else if shape === "ellipse"}
          <ellipse cx="10" cy="10" rx="8" ry="5" />
        {:else if shape === "diamond"}
          <polygon points="10,3 17,10 10,17 3,10" />
        {:else if shape === "triangle"}
          <polygon points="10,4 17,16 3,16" />
        {/if}
      </svg>
      <span class="vc-shape-picker-label">{LABELS[shape]}</span>
    </button>
  {/each}
</div>

<style>
  .vc-shape-picker {
    display: flex;
    flex-direction: column;
    padding: 2px 0;
  }

  .vc-shape-picker-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    border: none;
    font: inherit;
    font-size: 14px;
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
  }

  .vc-shape-picker-row:hover,
  .vc-shape-picker-row:focus-visible {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    outline: none;
  }

  .vc-shape-picker-row--selected {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    box-shadow: inset 0 0 0 1px var(--color-accent);
  }

  .vc-shape-picker-icon {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .vc-shape-picker-label {
    flex: 1;
    min-width: 0;
  }
</style>
