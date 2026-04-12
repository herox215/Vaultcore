<script lang="ts">
  import { onDestroy } from "svelte";
  import { X } from "lucide-svelte";
  import { themeStore, type Theme } from "../../store/themeStore";
  import {
    settingsStore,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    type BodyFont,
    type MonoFont,
  } from "../../store/settingsStore";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  let currentTheme = $state<Theme>("auto");
  let currentBody = $state<BodyFont>("system");
  let currentMono = $state<MonoFont>("system");
  let currentSize = $state<number>(14);

  const unsubTheme = themeStore.subscribe((t) => { currentTheme = t; });
  const unsubSettings = settingsStore.subscribe((s) => {
    currentBody = s.fontBody; currentMono = s.fontMono; currentSize = s.fontSize;
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function onThemeChange(e: Event) {
    const v = (e.target as HTMLInputElement).value as Theme;
    themeStore.set(v);
  }
  function onBodyChange(e: Event) {
    settingsStore.setFontBody((e.target as HTMLSelectElement).value as BodyFont);
  }
  function onMonoChange(e: Event) {
    settingsStore.setFontMono((e.target as HTMLSelectElement).value as MonoFont);
  }
  function onSizeInput(e: Event) {
    settingsStore.setFontSize(Number((e.target as HTMLInputElement).value));
  }

  onDestroy(() => { unsubTheme(); unsubSettings(); });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="vc-settings-backdrop" onclick={onClose} role="presentation"></div>
  <div class="vc-settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings-modal">
    <header class="vc-settings-header">
      <h2 id="settings-title" class="vc-settings-title">Einstellungen</h2>
      <button
        class="vc-settings-close"
        onclick={onClose}
        aria-label="Einstellungen schließen"
        type="button"
      ><X size={16} /></button>
    </header>

    <div class="vc-settings-content">
      <!-- Section A — Erscheinungsbild -->
      <section>
        <h3 class="vc-settings-section-title">ERSCHEINUNGSBILD</h3>
        <div class="vc-theme-radio-group" role="radiogroup" aria-label="Erscheinungsbild">
          {#each [{ id: "auto", label: "Automatisch" }, { id: "light", label: "Hell" }, { id: "dark", label: "Dunkel" }] as opt}
            <label class="vc-theme-radio" class:vc-theme-radio--active={currentTheme === opt.id}>
              <input
                type="radio"
                name="theme"
                value={opt.id}
                checked={currentTheme === opt.id}
                onchange={onThemeChange}
              />
              <span>{opt.label}</span>
            </label>
          {/each}
        </div>
      </section>

      <!-- Section B — Schrift -->
      <section class="vc-settings-section">
        <h3 class="vc-settings-section-title">SCHRIFT</h3>
        <div class="vc-settings-row">
          <label for="font-body-select">Schriftart</label>
          <select id="font-body-select" value={currentBody} onchange={onBodyChange}>
            <option value="system">System UI (Standard)</option>
            <option value="inter">Inter</option>
            <option value="lora">Lora</option>
          </select>
        </div>
        <div class="vc-settings-row">
          <label for="font-mono-select">Monospace-Schrift</label>
          <select id="font-mono-select" value={currentMono} onchange={onMonoChange}>
            <option value="system">System Mono (Standard)</option>
            <option value="jetbrains-mono">JetBrains Mono</option>
            <option value="fira-code">Fira Code</option>
          </select>
        </div>
        <div class="vc-settings-row">
          <label for="font-size-slider">Schriftgröße</label>
          <span class="vc-settings-size-value">{currentSize} px</span>
        </div>
        <input
          id="font-size-slider"
          class="vc-settings-slider"
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step="1"
          value={currentSize}
          oninput={onSizeInput}
          aria-label="Schriftgröße"
          aria-valuemin={FONT_SIZE_MIN}
          aria-valuemax={FONT_SIZE_MAX}
          aria-valuenow={currentSize}
        />
      </section>

      <!-- Section C — Tastaturkürzel (Plan 03 fills in) -->
      <section class="vc-settings-section" data-testid="settings-shortcuts-placeholder">
        <h3 class="vc-settings-section-title">TASTATURKÜRZEL</h3>
        <p style="font-size:12px;color:var(--color-text-muted);margin:0;">
          (wird in Plan 03 ergänzt)
        </p>
      </section>
    </div>
  </div>
{/if}

<style>
  .vc-settings-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 300;
  }
  .vc-settings-modal {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 520px; max-height: 80vh;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    display: flex; flex-direction: column;
    overflow: hidden;
    z-index: 301;
  }
  .vc-settings-header {
    height: 32px; flex-shrink: 0;
    padding: 0 16px;
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid var(--color-border);
  }
  .vc-settings-title { font-size: 14px; font-weight: 600; margin: 0; color: var(--color-text); }
  .vc-settings-close {
    width: 28px; height: 28px;
    background: none; border: none; cursor: pointer;
    color: var(--color-text-muted);
    display: flex; align-items: center; justify-content: center;
    border-radius: 4px;
  }
  .vc-settings-close:hover { background: var(--color-accent-bg); color: var(--color-text); }
  .vc-settings-content {
    flex: 1 1 0;
    padding: 24px 24px 32px;
    overflow-y: auto;
    display: flex; flex-direction: column;
    gap: 24px;
  }
  .vc-settings-section-title {
    font-size: 12px; font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 12px 0;
  }
  .vc-theme-radio-group { display: flex; gap: 8px; }
  .vc-theme-radio {
    flex: 1; height: 36px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--color-border); border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    color: var(--color-text);
    background: var(--color-surface);
  }
  .vc-theme-radio:hover { background: var(--color-accent-bg); }
  .vc-theme-radio input { display: none; }
  .vc-theme-radio--active {
    border-color: var(--color-accent);
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }
  .vc-settings-row {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px; gap: 16px;
  }
  .vc-settings-row label { font-size: 14px; color: var(--color-text); }
  .vc-settings-row select {
    font-size: 14px; padding: 4px 8px;
    border: 1px solid var(--color-border); border-radius: 4px;
    background: var(--color-surface); color: var(--color-text);
    min-width: 180px;
  }
  .vc-settings-size-value { font-size: 14px; color: var(--color-text-muted); }
  .vc-settings-slider { width: 100%; }
</style>
