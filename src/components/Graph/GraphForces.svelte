<script lang="ts">
  import { X, Pause, Play } from "lucide-svelte";
  import type { ForceSettings } from "./graphRender";

  interface Props {
    settings: ForceSettings;
    frozen: boolean;
    onSettingsChange: (s: ForceSettings) => void;
    onFrozenChange: (f: boolean) => void;
    onClose: () => void;
  }

  let {
    settings,
    frozen,
    onSettingsChange,
    onFrozenChange,
    onClose,
  }: Props = $props();

  // Local staging so the slider is smooth — each `oninput` writes through
  // to the parent, which mutates the live supervisor's settings in place.
  function update(patch: Partial<ForceSettings>): void {
    onSettingsChange({ ...settings, ...patch });
  }
</script>

<div class="vc-forces-panel" role="dialog" aria-label="Graph forces">
  <div class="vc-forces-header">
    <span class="vc-forces-title">Forces</span>
    <button
      type="button"
      class="vc-forces-close"
      onclick={onClose}
      aria-label="Close forces panel"
      title="Schließen"
    >
      <X size={14} strokeWidth={1.75} />
    </button>
  </div>

  <button
    type="button"
    class="vc-forces-freeze"
    class:vc-forces-freeze--on={frozen}
    onclick={() => onFrozenChange(!frozen)}
    aria-pressed={frozen}
    title={frozen ? "Simulation weiterlaufen lassen" : "Simulation pausieren"}
  >
    {#if frozen}
      <Play size={14} strokeWidth={1.75} />
      <span>Weiterlaufen</span>
    {:else}
      <Pause size={14} strokeWidth={1.75} />
      <span>Einfrieren</span>
    {/if}
  </button>

  <label class="vc-forces-row">
    <span class="vc-forces-label">
      Center
      <span class="vc-forces-value">{settings.gravity.toFixed(2)}</span>
    </span>
    <input
      type="range"
      min="0"
      max="5"
      step="0.1"
      value={settings.gravity}
      oninput={(e) => update({ gravity: Number(e.currentTarget.value) })}
    />
  </label>

  <label class="vc-forces-row">
    <span class="vc-forces-label">
      Repel
      <span class="vc-forces-value">{settings.scalingRatio.toFixed(0)}</span>
    </span>
    <input
      type="range"
      min="1"
      max="50"
      step="1"
      value={settings.scalingRatio}
      oninput={(e) => update({ scalingRatio: Number(e.currentTarget.value) })}
    />
  </label>

  <label class="vc-forces-row">
    <span class="vc-forces-label">
      Link
      <span class="vc-forces-value">{settings.edgeWeightInfluence.toFixed(2)}</span>
    </span>
    <input
      type="range"
      min="0"
      max="3"
      step="0.1"
      value={settings.edgeWeightInfluence}
      oninput={(e) =>
        update({ edgeWeightInfluence: Number(e.currentTarget.value) })}
    />
  </label>

  <label class="vc-forces-row">
    <span class="vc-forces-label">
      Friction
      <span class="vc-forces-value">{settings.slowDown.toFixed(1)}</span>
    </span>
    <input
      type="range"
      min="0.5"
      max="20"
      step="0.5"
      value={settings.slowDown}
      oninput={(e) => update({ slowDown: Number(e.currentTarget.value) })}
    />
  </label>
</div>

<style>
  .vc-forces-panel {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 10;
    width: 220px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
  .vc-forces-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .vc-forces-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .vc-forces-close {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    border-radius: 3px;
  }
  .vc-forces-close:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }
  .vc-forces-freeze {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: transparent;
    color: var(--color-text);
    cursor: pointer;
  }
  .vc-forces-freeze:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .vc-forces-freeze--on {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .vc-forces-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .vc-forces-label {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-muted);
  }
  .vc-forces-value {
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }
  .vc-forces-row input[type="range"] {
    width: 100%;
    accent-color: var(--color-accent);
  }
</style>
