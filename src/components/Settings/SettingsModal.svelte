<script lang="ts">
  import { onDestroy } from "svelte";
  import { X, RefreshCw } from "lucide-svelte";
  import { themeStore, type Theme } from "../../store/themeStore";
  import {
    settingsStore,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    type BodyFont,
    type MonoFont,
  } from "../../store/settingsStore";
  import { DEFAULT_DAILY_DATE_FORMAT } from "../../lib/dailyNotes";
  import { vaultStore } from "../../store/vaultStore";
  import { snippetsStore } from "../../store/snippetsStore";
  import { formatShortcut } from "../../lib/shortcuts";
  import { commandRegistry, type Command } from "../../lib/commands/registry";

  let { open, onClose, onSwitchVault }: {
    open: boolean;
    onClose: () => void;
    onSwitchVault: () => void;
  } = $props();

  let currentTheme = $state<Theme>("auto");
  let currentBody = $state<BodyFont>("system");
  let currentMono = $state<MonoFont>("system");
  let currentSize = $state<number>(14);
  let currentVaultPath = $state<string | null>(null);
  let shortcuts = $state<Command[]>([]);
  let dailyFolder = $state<string>("");
  let dailyFormat = $state<string>(DEFAULT_DAILY_DATE_FORMAT);
  let dailyTemplate = $state<string>("");
  let snippetsAvailable = $state<string[]>([]);
  let snippetsEnabled = $state<string[]>([]);
  let snippetsLoaded = $state<boolean>(false);
  let refreshingSnippets = $state<boolean>(false);

  const unsubTheme = themeStore.subscribe((t) => { currentTheme = t; });
  const unsubSettings = settingsStore.subscribe((s) => {
    currentBody = s.fontBody;
    currentMono = s.fontMono;
    currentSize = s.fontSize;
    dailyFolder = s.dailyNotesFolder;
    dailyFormat = s.dailyNotesDateFormat;
    dailyTemplate = s.dailyNotesTemplate;
  });
  const unsubVault = vaultStore.subscribe((s) => { currentVaultPath = s.currentPath; });
  const unsubCommands = commandRegistry.subscribe((list) => {
    shortcuts = list.filter((c) => c.hotkey);
  });
  const unsubSnippets = snippetsStore.subscribe((s) => {
    snippetsAvailable = s.available;
    snippetsEnabled = s.enabled;
    snippetsLoaded = s.loaded;
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
  function onDailyFolderInput(e: Event) {
    settingsStore.setDailyNotesFolder((e.target as HTMLInputElement).value);
  }
  function onDailyFormatInput(e: Event) {
    settingsStore.setDailyNotesDateFormat((e.target as HTMLInputElement).value);
  }
  function onDailyTemplateInput(e: Event) {
    settingsStore.setDailyNotesTemplate((e.target as HTMLInputElement).value);
  }

  async function onToggleSnippet(name: string): Promise<void> {
    if (!currentVaultPath) return;
    await snippetsStore.toggle(name, currentVaultPath);
  }

  async function onRefreshSnippets(): Promise<void> {
    if (!currentVaultPath || refreshingSnippets) return;
    refreshingSnippets = true;
    try {
      await snippetsStore.load(currentVaultPath);
    } finally {
      refreshingSnippets = false;
    }
  }

  onDestroy(() => { unsubTheme(); unsubSettings(); unsubVault(); unsubCommands(); unsubSnippets(); });
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
      <!-- Section — Vault -->
      <section data-testid="settings-vault">
        <h3 class="vc-settings-section-title">VAULT</h3>
        <div class="vc-settings-row vc-vault-row">
          <div class="vc-vault-path-wrap">
            <div class="vc-vault-path-label">Aktueller Vault</div>
            <div class="vc-vault-path" title={currentVaultPath ?? ""}>
              {currentVaultPath ?? "—"}
            </div>
          </div>
          <button
            type="button"
            class="vc-vault-switch-btn"
            onclick={onSwitchVault}
            data-testid="settings-switch-vault"
          >Vault wechseln…</button>
        </div>
      </section>

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

      <!-- Section — CSS-Snippets (#64) -->
      <section class="vc-settings-section" data-testid="settings-snippets">
        <div class="vc-snippets-head">
          <h3 class="vc-settings-section-title">CSS-SNIPPETS</h3>
          <button
            type="button"
            class="vc-snippets-refresh"
            onclick={onRefreshSnippets}
            disabled={!currentVaultPath || refreshingSnippets}
            aria-label="Snippets neu laden"
            title="Snippets neu laden"
          ><RefreshCw size={14} /></button>
        </div>
        <p class="vc-snippets-hint">
          Lege <code>.css</code>-Dateien in <code>&lt;Vault&gt;/.vaultcore/snippets/</code> ab,
          um das Aussehen pro Vault anzupassen.
        </p>
        {#if !currentVaultPath}
          <p class="vc-snippets-empty">Öffne zuerst einen Vault.</p>
        {:else if snippetsLoaded && snippetsAvailable.length === 0}
          <p class="vc-snippets-empty">Keine Snippets gefunden.</p>
        {:else}
          <ul class="vc-snippets-list" role="list">
            {#each snippetsAvailable as name (name)}
              <li class="vc-snippets-item">
                <span class="vc-snippets-name" title={name}>{name}</span>
                <label class="vc-snippets-toggle">
                  <input
                    type="checkbox"
                    checked={snippetsEnabled.includes(name)}
                    onchange={() => onToggleSnippet(name)}
                    aria-label={`Snippet ${name} aktivieren`}
                  />
                  <span class="vc-snippets-toggle-track" aria-hidden="true">
                    <span class="vc-snippets-toggle-thumb"></span>
                  </span>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
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

      <!-- Section — Tagesnotizen (#59) -->
      <section class="vc-settings-section" data-testid="settings-daily-notes">
        <h3 class="vc-settings-section-title">TAGESNOTIZEN</h3>
        <div class="vc-settings-row">
          <label for="daily-folder-input">Ordner (relativ zum Vault)</label>
          <input
            id="daily-folder-input"
            data-testid="settings-daily-folder"
            type="text"
            class="vc-settings-text"
            placeholder="z. B. Daily"
            value={dailyFolder}
            oninput={onDailyFolderInput}
          />
        </div>
        <div class="vc-settings-row">
          <label for="daily-format-input">Datumsformat</label>
          <input
            id="daily-format-input"
            data-testid="settings-daily-format"
            type="text"
            class="vc-settings-text"
            placeholder={DEFAULT_DAILY_DATE_FORMAT}
            value={dailyFormat}
            oninput={onDailyFormatInput}
          />
        </div>
        <div class="vc-settings-row">
          <label for="daily-template-input">Vorlage (relativ zum Vault)</label>
          <input
            id="daily-template-input"
            data-testid="settings-daily-template"
            type="text"
            class="vc-settings-text"
            placeholder="z. B. Templates/Daily.md"
            value={dailyTemplate}
            oninput={onDailyTemplateInput}
          />
        </div>
        <p class="vc-settings-hint">
          Unterstützte Tokens: <code>YYYY</code>, <code>MM</code>, <code>DD</code>.
          Fehlender Ordner wird beim ersten Öffnen erstellt.
        </p>
      </section>

      <!-- Section C — Tastaturkürzel (UI-05 / D-11) -->
      <section class="vc-settings-section" data-testid="settings-shortcuts">
        <h3 class="vc-settings-section-title">TASTATURKÜRZEL</h3>
        <table class="vc-shortcuts-table" role="table">
          <tbody>
            {#each shortcuts as s (s.id)}
              <tr role="row">
                <td role="cell" class="vc-shortcut-action">{s.name}</td>
                <td role="cell" class="vc-shortcut-keys"><kbd>{s.hotkey ? formatShortcut(s.hotkey) : ""}</kbd></td>
              </tr>
            {/each}
          </tbody>
        </table>
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
    /* BUG-05.1: previously flat (min-height not set), sections crowded.
       Give the modal a generous default size so all three sections breathe. */
    width: 600px; min-height: 560px; max-height: 85vh;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    display: flex; flex-direction: column;
    overflow: hidden;
    z-index: 301;
  }
  .vc-settings-header {
    height: 48px; flex-shrink: 0;
    padding: 0 24px;
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
  .vc-settings-row :global(.vc-settings-text) {
    font-size: 14px; padding: 4px 8px;
    border: 1px solid var(--color-border); border-radius: 4px;
    background: var(--color-surface); color: var(--color-text);
    min-width: 240px;
    font-family: var(--vc-font-mono);
  }
  .vc-settings-hint {
    font-size: 12px;
    color: var(--color-text-muted);
    margin: 4px 0 0;
  }
  .vc-settings-hint code {
    font-family: var(--vc-font-mono);
    padding: 0 4px;
    background: var(--color-accent-bg);
    border-radius: 3px;
  }
  .vc-settings-size-value { font-size: 14px; color: var(--color-text-muted); }
  .vc-settings-slider { width: 100%; }

  .vc-vault-row { align-items: flex-start; margin-bottom: 0; }
  .vc-vault-path-wrap { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .vc-vault-path-label { font-size: 14px; color: var(--color-text); }
  .vc-vault-path {
    font-family: var(--vc-font-mono);
    font-size: 12px;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vc-vault-switch-btn {
    flex-shrink: 0;
    height: 32px;
    padding: 0 12px;
    font-size: 13px;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
  }
  .vc-vault-switch-btn:hover {
    background: var(--color-accent-bg);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  /* Section — CSS-Snippets */
  .vc-snippets-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 6px;
  }
  .vc-snippets-head .vc-settings-section-title { margin: 0; }
  .vc-snippets-refresh {
    width: 28px; height: 28px;
    background: none; border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    border-radius: 4px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .vc-snippets-refresh:hover:not(:disabled) {
    background: var(--color-accent-bg); color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .vc-snippets-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
  .vc-snippets-hint {
    margin: 0 0 12px 0;
    font-size: 12px; line-height: 1.5;
    color: var(--color-text-muted);
  }
  .vc-snippets-hint code {
    font-family: var(--vc-font-mono);
    font-size: 11px;
    padding: 1px 4px;
    background: var(--color-surface-alt, rgba(0,0,0,0.06));
    border-radius: 3px;
  }
  .vc-snippets-empty {
    margin: 0;
    font-size: 13px;
    color: var(--color-text-muted);
    font-style: italic;
  }
  .vc-snippets-list {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }
  .vc-snippets-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px;
    font-size: 13px; color: var(--color-text);
  }
  .vc-snippets-item + .vc-snippets-item {
    border-top: 1px solid var(--color-border);
  }
  .vc-snippets-name {
    font-family: var(--vc-font-mono);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 0; min-width: 0;
    margin-right: 12px;
  }
  .vc-snippets-toggle {
    position: relative;
    flex-shrink: 0;
    cursor: pointer;
  }
  .vc-snippets-toggle input {
    position: absolute; inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .vc-snippets-toggle-track {
    display: inline-block;
    width: 32px; height: 18px;
    background: var(--color-border);
    border-radius: 999px;
    position: relative;
    transition: background 120ms ease;
  }
  .vc-snippets-toggle-thumb {
    position: absolute;
    top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--color-surface);
    border-radius: 50%;
    transition: transform 120ms ease;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }
  .vc-snippets-toggle input:checked + .vc-snippets-toggle-track {
    background: var(--color-accent);
  }
  .vc-snippets-toggle input:checked + .vc-snippets-toggle-track .vc-snippets-toggle-thumb {
    transform: translateX(14px);
  }
  .vc-snippets-toggle input:focus-visible + .vc-snippets-toggle-track {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  /* Section C — Tastaturkürzel */
  .vc-shortcuts-table { width: 100%; border-collapse: collapse; }
  .vc-shortcuts-table tr:nth-child(even) { background: var(--color-bg); }
  .vc-shortcuts-table td { padding: 6px 16px; font-size: 14px; color: var(--color-text); }
  .vc-shortcut-keys { text-align: right; }
  .vc-shortcut-keys kbd {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 6px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text);
    font-family: var(--vc-font-mono);
  }
</style>
