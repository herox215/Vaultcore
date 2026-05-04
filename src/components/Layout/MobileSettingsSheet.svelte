<script lang="ts">
  /**
   * MobileSettingsSheet — full-screen settings sheet for mobile (#394).
   *
   * Parent-gated: VaultLayout decides via `{#if isMobile}` when to render
   * this OR the desktop SettingsModal; component does NOT subscribe to
   * viewportStore. State lives in the parent.
   *
   * Per team-lead direction this is an opaque full-screen sheet — no
   * scrim. The X close button + Escape are the dismissal paths.
   *
   * Master/detail navigation (same shape as the burger sheet from #397):
   *   - master = 5-row category list.
   *   - detail = the chosen category's controls, with a back button.
   *
   * Categories rebuild the relevant SettingsModal sections against the
   * SAME stores (themeStore, settingsStore, vaultStore). Stores are the
   * single source of truth — mobile and desktop see identical state.
   *
   * Excluded sections (per ticket): keyboard shortcut customization,
   * plugin settings, snippets management, build version, security.
   * Auto-lock is included — it's a pure setting on settingsStore with no
   * encrypted-folders UI dependency.
   */
  import { X, ChevronLeft, ChevronRight, Palette, Type, Calendar, ShieldCheck, FolderOpen, Network } from "lucide-svelte";
  import { themeStore, type Theme } from "../../store/themeStore";
  import {
    settingsStore,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    AUTO_LOCK_MINUTES_MIN,
    AUTO_LOCK_MINUTES_MAX,
    type BodyFont,
    type MonoFont,
  } from "../../store/settingsStore";
  import { vaultStore } from "../../store/vaultStore";
  import {
    selfIdentity,
    discoverable as discoverableStore,
    discoveredPeers,
    pairedPeers,
    setDiscoverable,
    revokePeer,
  } from "../../store/syncStore";
  import { openPairingModal, openPairingModalWithAddr } from "../../store/pairingModalStore";
  import { onDestroy } from "svelte";

  let {
    open,
    onClose,
    onSwitchVault,
  }: {
    open: boolean;
    onClose: () => void;
    onSwitchVault: () => void;
  } = $props();

  type CategoryId = "appearance" | "fonts" | "daily" | "security" | "vault" | "sync";
  let activeCategory = $state<CategoryId | null>(null);
  // bind:this writes a live DOM node here — $state matches the drawer /
  // burger pattern so Svelte's reactive scope sees the binding writes
  // and the keydown trap can read sheetEl without warnings.
  let sheetEl = $state<HTMLDivElement | undefined>(undefined);

  // Subscribe to the stores once. Per-control reactive bindings would
  // also work, but explicit subscriptions match SettingsModal's pattern
  // and make the test mock surface obvious.
  let currentTheme = $state<Theme>("auto");
  let currentBody = $state<BodyFont>("system");
  let currentMono = $state<MonoFont>("system");
  let currentSize = $state<number>(14);
  let dailyFolder = $state<string>("");
  let dailyFormat = $state<string>("");
  let dailyTemplate = $state<string>("");
  let autoLockMinutes = $state<number>(15);
  let currentVaultPath = $state<string | null>(null);

  const unsubTheme = themeStore.subscribe((t) => { currentTheme = t; });
  const unsubSettings = settingsStore.subscribe((s) => {
    currentBody = s.fontBody;
    currentMono = s.fontMono;
    currentSize = s.fontSize;
    dailyFolder = s.dailyNotesFolder;
    dailyFormat = s.dailyNotesDateFormat;
    dailyTemplate = s.dailyNotesTemplate;
    autoLockMinutes = s.autoLockMinutes;
  });
  const unsubVault = vaultStore.subscribe((s) => { currentVaultPath = s.currentPath; });

  onDestroy(() => { unsubTheme(); unsubSettings(); unsubVault(); });

  $effect(() => {
    if (!open) activeCategory = null;
  });

  $effect(() => {
    if (open) {
      queueMicrotask(() => {
        const first = sheetEl?.querySelector<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
        );
        first?.focus();
      });
    }
  });

  const CATEGORIES: ReadonlyArray<{
    id: CategoryId;
    label: string;
    icon: typeof Palette;
  }> = [
    { id: "vault",      label: "Vault",            icon: FolderOpen },
    { id: "sync",       label: "Synchronisieren",  icon: Network },
    { id: "appearance", label: "Erscheinungsbild", icon: Palette },
    { id: "fonts",      label: "Schrift",          icon: Type },
    { id: "daily",      label: "Tagesnotizen",     icon: Calendar },
    { id: "security",   label: "Sicherheit",       icon: ShieldCheck },
  ];

  function onThemeChange(e: Event) {
    themeStore.set((e.target as HTMLInputElement).value as Theme);
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
  function onAutoLockInput(e: Event) {
    settingsStore.setAutoLockMinutes(Number((e.target as HTMLInputElement).value));
  }

  // Boundary-only focus trap (matches burger sheet from #397).
  const FOCUSABLE_SELECTOR = [
    'button:not([disabled]):not([tabindex="-1"])',
    'a[href]:not([tabindex="-1"])',
    'input:not([disabled]):not([tabindex="-1"])',
    'select:not([disabled]):not([tabindex="-1"])',
    'textarea:not([disabled]):not([tabindex="-1"])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  function focusables(): HTMLElement[] {
    if (!sheetEl) return [];
    return Array.from(sheetEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (activeCategory !== null) activeCategory = null;
      else onClose();
      return;
    }
    if (e.key === "Tab") {
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  const CATEGORY_LABELS: Record<CategoryId, string> = {
    appearance: "Erscheinungsbild",
    fonts: "Schrift",
    daily: "Tagesnotizen",
    security: "Sicherheit",
    vault: "Vault",
    sync: "Synchronisieren",
  };

  // ── Sync category state (UI-7) ─────────────────────────────────────────
  let manualPeerAddr = $state("");
  function onPairManual(): void {
    const v = manualPeerAddr.trim();
    if (!v) return;
    openPairingModalWithAddr(v);
    manualPeerAddr = "";
  }
  function onPairNew(): void {
    openPairingModal();
  }
  function onPairDiscovered(peer: import("../../ipc/commands").DiscoveredPeer): void {
    openPairingModal(peer);
  }
  async function onToggleDiscoverable(e: Event): Promise<void> {
    await setDiscoverable((e.target as HTMLInputElement).checked);
  }
  async function onRevokePeer(deviceId: string, name: string): Promise<void> {
    if (!confirm(`Synchronisierung mit ${name} widerrufen?`)) return;
    await revokePeer(deviceId);
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="vc-mobile-settings-sheet"
    bind:this={sheetEl}
    role="dialog"
    aria-modal="true"
    aria-label="Einstellungen"
    tabindex="-1"
    onkeydown={onKeydown}
  >
    <header class="vc-mobile-settings-header">
      {#if activeCategory === null}
        <h2 class="vc-mobile-settings-title">Einstellungen</h2>
        <button
          type="button"
          class="vc-mobile-settings-close"
          onclick={onClose}
          aria-label="Einstellungen schließen"
        >
          <X size={20} strokeWidth={1.5} />
        </button>
      {:else}
        <button
          type="button"
          class="vc-mobile-settings-back"
          onclick={() => (activeCategory = null)}
          aria-label="Zurück"
        >
          <ChevronLeft size={20} strokeWidth={1.5} />
        </button>
        <h2 class="vc-mobile-settings-title">{CATEGORY_LABELS[activeCategory]}</h2>
      {/if}
    </header>

    <div class="vc-mobile-settings-body">
      {#if activeCategory === null}
        <div class="vc-mobile-settings-list" role="menu">
          {#each CATEGORIES as cat (cat.id)}
            {@const Icon = cat.icon}
            <button
              type="button"
              role="menuitem"
              data-row-id={cat.id}
              class="vc-mobile-settings-row"
              onclick={() => (activeCategory = cat.id)}
            >
              <Icon size={20} strokeWidth={1.5} />
              <span class="vc-mobile-settings-row-label">{cat.label}</span>
              <ChevronRight size={16} strokeWidth={1.5} />
            </button>
          {/each}
        </div>
      {:else if activeCategory === "appearance"}
        <section class="vc-mobile-settings-section">
          <div class="vc-theme-radio-group" role="radiogroup" aria-label="Erscheinungsbild">
            {#each [{ id: "auto", label: "Automatisch" }, { id: "light", label: "Hell" }, { id: "dark", label: "Dunkel" }] as opt (opt.id)}
              <label class="vc-mobile-settings-radio">
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
      {:else if activeCategory === "fonts"}
        <section class="vc-mobile-settings-section">
          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Textschrift</span>
            <select value={currentBody} onchange={onBodyChange}>
              <option value="system">Systemschrift</option>
              <option value="inter">Inter</option>
              <option value="lora">Lora</option>
            </select>
          </label>
          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Monospace</span>
            <select value={currentMono} onchange={onMonoChange}>
              <option value="system">Systemschrift</option>
              <option value="jetbrains-mono">JetBrains Mono</option>
              <option value="fira-code">Fira Code</option>
            </select>
          </label>
          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Schriftgröße ({currentSize} px)</span>
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step="1"
              value={currentSize}
              oninput={onSizeInput}
              aria-label="Schriftgröße"
            />
          </label>
        </section>
      {:else if activeCategory === "daily"}
        <section class="vc-mobile-settings-section">
          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Ordner</span>
            <input type="text" value={dailyFolder} oninput={onDailyFolderInput} />
          </label>
          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Datumsformat</span>
            <input type="text" value={dailyFormat} oninput={onDailyFormatInput} />
          </label>
          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Vorlage</span>
            <input type="text" value={dailyTemplate} oninput={onDailyTemplateInput} />
          </label>
        </section>
      {:else if activeCategory === "security"}
        <section class="vc-mobile-settings-section">
          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Auto-Sperre nach (Minuten)</span>
            <input
              type="number"
              min={AUTO_LOCK_MINUTES_MIN}
              max={AUTO_LOCK_MINUTES_MAX}
              value={autoLockMinutes}
              oninput={onAutoLockInput}
            />
          </label>
        </section>
      {:else if activeCategory === "vault"}
        <section class="vc-mobile-settings-section">
          <div class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Aktueller Vault</span>
            <div class="vc-mobile-settings-vault-path">{currentVaultPath ?? "—"}</div>
          </div>
          <button
            type="button"
            class="vc-mobile-settings-action"
            data-testid="settings-switch-vault"
            onclick={onSwitchVault}
          >
            Vault wechseln…
          </button>
        </section>
      {:else if activeCategory === "sync"}
        <section class="vc-mobile-settings-section" data-testid="settings-sync">
          <div class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Dieses Gerät</span>
            <div class="vc-mobile-settings-vault-path">{$selfIdentity?.device_name ?? "—"}</div>
            <div class="vc-mobile-settings-vault-path" style="font-size: 11px; opacity: 0.7;">
              {$selfIdentity?.device_id ?? ""}
            </div>
          </div>

          <label class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Auf diesem Netzwerk sichtbar</span>
            <input
              type="checkbox"
              checked={$discoverableStore}
              onchange={onToggleDiscoverable}
            />
          </label>

          <div class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">In diesem Netzwerk gesehen</span>
            {#if $discoveredPeers.length === 0}
              <div class="vc-mobile-settings-vault-path" style="opacity: 0.7;">
                Keine Geräte gefunden
              </div>
            {:else}
              {#each $discoveredPeers as p (p.device_id)}
                <div class="vc-mobile-settings-field">
                  <div class="vc-mobile-settings-vault-path">{p.device_name}</div>
                  <div class="vc-mobile-settings-vault-path" style="font-size: 11px; opacity: 0.7;">
                    {p.addr || "(keine Adresse)"}
                  </div>
                  <button
                    type="button"
                    class="vc-mobile-settings-action"
                    onclick={() => onPairDiscovered(p)}
                  >
                    Koppeln…
                  </button>
                </div>
              {/each}
            {/if}
          </div>

          <div class="vc-mobile-settings-field">
            <span class="vc-mobile-settings-field-label">Mit IP koppeln</span>
            <input
              type="text"
              placeholder="z.B. 192.168.1.42"
              bind:value={manualPeerAddr}
              data-testid="settings-sync-manual-addr"
              aria-label="Peer-Adresse manuell eingeben"
            />
          </div>
          <button
            type="button"
            class="vc-mobile-settings-action"
            disabled={!manualPeerAddr.trim()}
            onclick={onPairManual}
            data-testid="settings-sync-pair-manual"
          >
            Mit IP koppeln
          </button>

          <button
            type="button"
            class="vc-mobile-settings-action"
            onclick={onPairNew}
            data-testid="settings-sync-pair-new"
          >
            Neues Gerät koppeln…
          </button>

          {#if $pairedPeers.length > 0}
            <div class="vc-mobile-settings-field">
              <span class="vc-mobile-settings-field-label">Gekoppelte Geräte</span>
            </div>
            {#each $pairedPeers as peer (peer.device_id)}
              <div class="vc-mobile-settings-field">
                <div class="vc-mobile-settings-vault-path">{peer.device_name}</div>
                <button
                  type="button"
                  class="vc-mobile-settings-action"
                  onclick={() => onRevokePeer(peer.device_id, peer.device_name)}
                  aria-label={`Synchronisierung mit ${peer.device_name} widerrufen`}
                >
                  Widerrufen
                </button>
              </div>
            {/each}
          {/if}
        </section>
      {/if}
    </div>
  </div>
{/if}

<style>
  .vc-mobile-settings-sheet {
    position: fixed;
    inset: 0;
    background: var(--color-surface);
    z-index: 80;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    /* No scrim — opaque full-screen per #394 plan. */
  }

  .vc-mobile-settings-header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    padding: 0 8px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .vc-mobile-settings-title {
    flex: 1;
    margin: 0;
    font-family: var(--vc-font-body);
    font-size: 16px;
    font-weight: 600;
    color: var(--color-text);
  }

  .vc-mobile-settings-close,
  .vc-mobile-settings-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    min-width: var(--vc-hit-target, 44px);
    min-height: var(--vc-hit-target, 44px);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text-muted);
  }

  .vc-mobile-settings-close:hover,
  .vc-mobile-settings-back:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-mobile-settings-body {
    flex: 1;
    overflow-y: auto;
  }

  .vc-mobile-settings-list {
    display: flex;
    flex-direction: column;
  }

  .vc-mobile-settings-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 56px;
    min-height: var(--vc-hit-target, 44px);
    padding: 0 16px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    color: var(--color-text);
    font-family: var(--vc-font-body);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
  }

  .vc-mobile-settings-row:hover {
    background: var(--color-accent-bg);
  }

  .vc-mobile-settings-row-label {
    flex: 1;
  }

  .vc-mobile-settings-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
  }

  .vc-mobile-settings-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .vc-mobile-settings-field-label {
    font-family: var(--vc-font-body);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .vc-mobile-settings-field input[type="text"],
  .vc-mobile-settings-field input[type="number"],
  .vc-mobile-settings-field select {
    width: 100%;
    min-height: var(--vc-hit-target, 44px);
    padding: 0 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--vc-font-body);
    font-size: 14px;
  }

  .vc-mobile-settings-field input[type="range"] {
    width: 100%;
  }

  .vc-mobile-settings-radio {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    min-height: var(--vc-hit-target, 44px);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
    font-family: var(--vc-font-body);
    font-size: 14px;
  }

  .vc-mobile-settings-radio input[type="radio"] {
    accent-color: var(--color-accent);
  }

  .vc-theme-radio-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .vc-mobile-settings-action {
    height: 44px;
    min-height: var(--vc-hit-target, 44px);
    padding: 0 16px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--vc-font-body);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }

  .vc-mobile-settings-action:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  .vc-mobile-settings-vault-path {
    padding: 12px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-family: var(--vc-font-mono);
    font-size: 13px;
    color: var(--color-text);
    word-break: break-all;
  }
</style>
