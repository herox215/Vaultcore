<script lang="ts">
  import { onDestroy } from "svelte";
  import { X, RefreshCw, Keyboard, RotateCcw, Copy } from "lucide-svelte";
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
  import { DEFAULT_DAILY_DATE_FORMAT } from "../../lib/dailyNotes";
  import { vaultStore } from "../../store/vaultStore";
  import { snippetsStore } from "../../store/snippetsStore";
  import { lockAllFolders } from "../../ipc/commands";
  import { encryptedFolders } from "../../store/encryptedFoldersStore";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";
  import { formatShortcut } from "../../lib/shortcuts";
  import { commandRegistry, hotkeysEqual, type Command, type HotKey } from "../../lib/commands/registry";
  import { DEFAULT_COMMAND_SPECS } from "../../lib/commands/defaultCommands";
  import {
    setHotkeyOverride,
    resetHotkeyOverride,
    hotkeyFromEvent,
    validateHotKey,
  } from "../../lib/commands/hotkeyOverrides";
  import {
    selfIdentity,
    discoverable,
    pairedPeers,
    discoveredPeers,
    setDiscoverable,
    setDeviceName,
    revokePeer,
  } from "../../store/syncStore";
  import { openPairingModal, openPairingModalWithAddr } from "../../store/pairingModalStore";
  import { relativeTime } from "../../lib/relativeTime";
  import type { DiscoveredPeer } from "../../ipc/commands";

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
  /** Command id currently listening for a new keydown, or null when idle. */
  let recordingFor = $state<string | null>(null);
  let recordError = $state<string | null>(null);
  interface PendingConflict {
    targetId: string;
    newKey: HotKey;
    conflictId: string;
    conflictName: string;
  }
  let pendingConflict = $state<PendingConflict | null>(null);

  const DEFAULTS_BY_ID: Record<string, HotKey | undefined> = Object.fromEntries(
    DEFAULT_COMMAND_SPECS.map((s) => [s.id, s.hotkey])
  );

  function defaultHotkey(id: string): HotKey | undefined {
    return DEFAULTS_BY_ID[id];
  }

  function hasDefault(id: string): boolean {
    return Boolean(DEFAULTS_BY_ID[id]);
  }
  let dailyFolder = $state<string>("");
  let dailyFormat = $state<string>(DEFAULT_DAILY_DATE_FORMAT);
  let dailyTemplate = $state<string>("");
  let snippetsAvailable = $state<string[]>([]);
  let snippetsEnabled = $state<string[]>([]);
  let snippetsLoaded = $state<boolean>(false);
  let refreshingSnippets = $state<boolean>(false);
  let autoLockMinutes = $state<number>(15);

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
  const unsubCommands = commandRegistry.subscribe((list) => {
    // Show every command that has either an effective hotkey or a spec
    // default — disabled (override=null) commands remain listed so the
    // user can rebind or reset them.
    shortcuts = list.filter((c) => c.hotkey || hasDefault(c.id));
  });
  const unsubSnippets = snippetsStore.subscribe((s) => {
    snippetsAvailable = s.available;
    snippetsEnabled = s.enabled;
    snippetsLoaded = s.loaded;
  });

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    // While a conflict modal is up, intercept Escape for cancel only.
    if (pendingConflict) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        pendingConflict = null;
      }
      return;
    }
    // While recording a new shortcut, capture the next keydown for it.
    if (recordingFor) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelRecording();
        return;
      }
      handleRecordKeydown(e);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function startRecording(id: string): void {
    recordError = null;
    recordingFor = id;
  }

  function cancelRecording(): void {
    recordingFor = null;
    recordError = null;
  }

  function handleRecordKeydown(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const id = recordingFor;
    if (!id) return;
    const candidate = hotkeyFromEvent(e);
    // null => pure modifier press; keep listening.
    if (!candidate) return;
    const v = validateHotKey(candidate);
    if (!v.ok) {
      recordError = v.reason;
      return;
    }
    commitBinding(id, candidate);
  }

  function commitBinding(id: string, newKey: HotKey): void {
    // Conflict detection against every other command's effective hotkey.
    const other = commandRegistry.getEffective().find((c) => {
      if (c.id === id) return false;
      if (!c.hotkey) return false;
      return hotkeysEqual(c.hotkey, newKey);
    });
    if (other) {
      pendingConflict = {
        targetId: id,
        newKey,
        conflictId: other.id,
        conflictName: other.name,
      };
      recordingFor = null;
      recordError = null;
      return;
    }
    setHotkeyOverride(id, newKey);
    recordingFor = null;
    recordError = null;
  }

  function resolveConflictUnbind(): void {
    if (!pendingConflict) return;
    const { targetId, newKey, conflictId } = pendingConflict;
    // Disable the other binding first, then apply the new one.
    setHotkeyOverride(conflictId, null);
    setHotkeyOverride(targetId, newKey);
    pendingConflict = null;
  }

  function resolveConflictCancel(): void {
    pendingConflict = null;
  }

  function onResetShortcut(id: string): void {
    resetHotkeyOverride(id);
  }

  function onBackdropClick(): void {
    if (recordingFor) {
      cancelRecording();
      return;
    }
    onClose();
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

  // ── SYNCHRONISIERUNG ───────────────────────────────────────────────────
  // Editable device name commits on blur or Enter. We track the "baseline"
  // value so an unchanged blur (user clicked away without editing) does not
  // dispatch a no-op IPC call.
  let deviceNameDraft = $state<string>("");
  let deviceNameBaseline = $state<string>("");
  const unsubSelfIdentity = selfIdentity.subscribe((id) => {
    if (!id) return;
    // If the user is mid-edit (draft differs from baseline) preserve their
    // typing across remote-driven identity refreshes.
    if (deviceNameDraft === deviceNameBaseline) {
      deviceNameDraft = id.device_name;
    }
    deviceNameBaseline = id.device_name;
  });

  async function commitDeviceName(): Promise<void> {
    const next = deviceNameDraft.trim();
    if (!next || next === deviceNameBaseline) return;
    try {
      await setDeviceName(next);
      deviceNameBaseline = next;
    } catch (e) {
      // Roll the draft back to the baseline on error so the input
      // visibly snaps to the still-effective name.
      deviceNameDraft = deviceNameBaseline;
      if (isVaultError(e)) toastStore.error(vaultErrorCopy(e));
      else toastStore.error("Gerätename konnte nicht gespeichert werden");
    }
  }

  function onDeviceNameKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  async function onDiscoverableToggle(e: Event): Promise<void> {
    const on = (e.target as HTMLInputElement).checked;
    try {
      await setDiscoverable(on);
    } catch (err) {
      if (isVaultError(err)) toastStore.error(vaultErrorCopy(err));
      else toastStore.error("Sichtbarkeit konnte nicht geändert werden");
    }
  }

  async function onCopy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard blocked (permissions / non-secure context). Stay silent —
      // the copy buttons are convenience; user can still select-and-copy.
    }
  }

  async function onRevokePeer(deviceId: string, deviceName: string): Promise<void> {
    const ok = window.confirm(
      `Synchronisierung mit "${deviceName}" wirklich widerrufen? Dieses Gerät erhält keine Updates mehr.`,
    );
    if (!ok) return;
    try {
      await revokePeer(deviceId);
    } catch (e) {
      if (isVaultError(e)) toastStore.error(vaultErrorCopy(e));
      else toastStore.error("Widerruf fehlgeschlagen");
    }
  }

  function onPairDiscovered(peer: DiscoveredPeer): void {
    openPairingModal(peer);
  }

  function onPairNew(): void {
    openPairingModal();
  }

  /** Manual peer-address entry — used when mDNS isn't available
   *  (Android pre-NSD bridge, multicast-blocked LANs). User types
   *  the other device's IP (optionally with :port), modal opens in
   *  responder mode and dials that address. */
  let manualPeerAddr = $state("");
  function onPairManual(): void {
    const v = manualPeerAddr.trim();
    if (!v) return;
    openPairingModalWithAddr(v);
    manualPeerAddr = "";
  }

  onDestroy(() => { unsubTheme(); unsubSettings(); unsubVault(); unsubCommands(); unsubSnippets(); unsubSelfIdentity(); });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="vc-settings-backdrop vc-modal-scrim" onclick={onBackdropClick} role="presentation"></div>
  <div class="vc-settings-modal vc-modal-surface" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings-modal">
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

      <!-- Section — Synchronisierung (UI-2) -->
      <section class="vc-settings-section" data-testid="settings-sync">
        <h3 class="vc-settings-section-title">SYNCHRONISIERUNG</h3>

        <!-- This-device card: editable name + device id + pubkey fingerprint -->
        <div class="vc-settings-row">
          <label for="sync-device-name">Gerätename</label>
          <input
            id="sync-device-name"
            class="vc-settings-text"
            type="text"
            value={deviceNameDraft}
            oninput={(e) => (deviceNameDraft = (e.target as HTMLInputElement).value)}
            onblur={commitDeviceName}
            onkeydown={onDeviceNameKeydown}
            data-testid="settings-sync-device-name"
            aria-label="Gerätename"
          />
        </div>
        <div class="vc-settings-row">
          <span>Geräte-ID</span>
          <span class="vc-sync-id-wrap">
            <code class="vc-sync-id">{$selfIdentity?.device_id ?? "—"}</code>
            <button
              type="button"
              class="vc-shortcut-btn"
              onclick={() => onCopy($selfIdentity?.device_id ?? "")}
              disabled={!$selfIdentity}
              aria-label="Geräte-ID kopieren"
              title="Geräte-ID kopieren"
            ><Copy size={14} /></button>
          </span>
        </div>
        <div class="vc-settings-row">
          <span>Schlüssel-Fingerabdruck</span>
          <span class="vc-sync-id-wrap">
            <code class="vc-sync-id">{$selfIdentity?.pubkey_fingerprint ?? "—"}</code>
            <button
              type="button"
              class="vc-shortcut-btn"
              onclick={() => onCopy($selfIdentity?.pubkey_fingerprint ?? "")}
              disabled={!$selfIdentity}
              aria-label="Schlüssel-Fingerabdruck kopieren"
              title="Schlüssel-Fingerabdruck kopieren"
            ><Copy size={14} /></button>
          </span>
        </div>

        <!-- Discoverable toggle (reuse the snippets toggle skin verbatim). -->
        <div class="vc-settings-row">
          <span>Im Netzwerk sichtbar</span>
          <label class="vc-snippets-toggle">
            <input
              type="checkbox"
              checked={$discoverable}
              onchange={onDiscoverableToggle}
              aria-label="Dieses Gerät im Netzwerk sichtbar machen"
              data-testid="settings-sync-discoverable"
            />
            <span class="vc-snippets-toggle-track" aria-hidden="true">
              <span class="vc-snippets-toggle-thumb"></span>
            </span>
          </label>
        </div>
        <p class="vc-settings-hint">
          Andere Geräte in diesem Netzwerk können dieses Gerät sehen und eine
          Kopplung anfragen. Aus, wenn keine Kopplung läuft.
        </p>

        <!-- Paired devices -->
        <h4 class="vc-sync-subhead">Gekoppelte Geräte</h4>
        {#if $pairedPeers.length === 0}
          <p class="vc-settings-hint">Noch keine gekoppelten Geräte.</p>
        {:else}
          <ul class="vc-security-list" role="list" data-testid="settings-sync-paired">
            {#each $pairedPeers as peer (peer.device_id)}
              <li class="vc-security-row">
                <span class="vc-sync-peer-name">{peer.device_name}</span>
                <span class="vc-sync-peer-meta">{relativeTime(peer.last_seen)}</span>
                <span class="vc-sync-peer-meta">
                  {#if peer.grants.length === 0}
                    keine Freigaben
                  {:else}
                    {peer.grants.map((g) => g.vault_name).join(", ")}
                  {/if}
                </span>
                <button
                  type="button"
                  class="vc-settings-btn vc-sync-revoke-btn"
                  onclick={() => onRevokePeer(peer.device_id, peer.device_name)}
                  aria-label={`Synchronisierung mit ${peer.device_name} widerrufen`}
                >Widerrufen</button>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- Discovered (ambient — no rescan button per user decision 5) -->
        <h4 class="vc-sync-subhead">In diesem Netzwerk gesehen</h4>
        {#if $discoveredPeers.length === 0}
          <p class="vc-settings-hint">
            {#if $discoverable}
              Suche nach Geräten…
            {:else}
              Aktiviere "Im Netzwerk sichtbar", um Geräte zu finden.
            {/if}
          </p>
        {:else}
          <ul class="vc-security-list" role="list" data-testid="settings-sync-discovered">
            {#each $discoveredPeers as peer (peer.device_id)}
              <li class="vc-security-row">
                <span class="vc-sync-peer-name">{peer.device_name}</span>
                <span class="vc-sync-peer-meta">{peer.addr || "—"}</span>
                <button
                  type="button"
                  class="vc-settings-btn"
                  onclick={() => onPairDiscovered(peer)}
                  aria-label={`Mit ${peer.device_name} koppeln`}
                >Koppeln…</button>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="vc-settings-row vc-sync-pair-row">
          <button
            type="button"
            class="vc-vault-switch-btn"
            onclick={onPairNew}
            data-testid="settings-sync-pair-new"
          >Neues Gerät koppeln…</button>
        </div>

        <!-- Manual peer entry: used when mDNS discovery isn't available
             (Android pre-NSD bridge, multicast-blocked LANs). Type the
             other device's IP (optionally :port) and pair. Reuses
             existing input + button styling. -->
        <div class="vc-settings-row vc-sync-pair-row">
          <input
            type="text"
            class="vc-settings-text"
            placeholder="z.B. 192.168.1.42 oder 192.168.1.42:17092"
            bind:value={manualPeerAddr}
            onkeydown={(e) => { if (e.key === "Enter") onPairManual(); }}
            data-testid="settings-sync-manual-addr"
            aria-label="Peer-Adresse manuell eingeben"
          />
          <button
            type="button"
            class="vc-settings-btn"
            disabled={!manualPeerAddr.trim()}
            onclick={onPairManual}
            data-testid="settings-sync-pair-manual"
          >Mit IP koppeln</button>
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

      <!-- Section — #345 encrypted folders. Copy is English per the
           decision captured in the 345 design discussion. -->
      <section class="vc-settings-section" data-testid="settings-security">
        <h3 class="vc-settings-section-title">SECURITY</h3>
        <div class="vc-settings-row">
          <label for="auto-lock-input">Auto-lock after</label>
          <div class="vc-settings-auto-lock-input">
            <input
              id="auto-lock-input"
              data-testid="settings-auto-lock-input"
              type="number"
              min={AUTO_LOCK_MINUTES_MIN}
              max={AUTO_LOCK_MINUTES_MAX}
              step={1}
              value={autoLockMinutes}
              onchange={(e) => {
                settingsStore.setAutoLockMinutes(Number((e.target as HTMLInputElement).value));
              }}
            />
            <span>min (0 = never)</span>
          </div>
        </div>
        <p class="vc-settings-hint">
          Unlocked folders re-lock automatically after this period of
          inactivity. Set to 0 to disable; folders still re-lock on
          app quit and on every vault reopen.
        </p>
        <div class="vc-settings-row">
          <span>Encrypted folders</span>
          <button
            type="button"
            class="vc-settings-btn"
            data-testid="settings-lock-all"
            onclick={async () => {
              try {
                await lockAllFolders();
                toastStore.info("All encrypted folders locked");
              } catch (e) {
                if (isVaultError(e)) toastStore.error(vaultErrorCopy(e));
                else toastStore.error("Failed to lock folders");
              }
            }}
            disabled={!currentVaultPath || $encryptedFolders.length === 0}
          >Lock all now</button>
        </div>
        {#if $encryptedFolders.length === 0}
          <p class="vc-settings-hint">
            No encrypted folders in this vault yet. Right-click a folder
            in the sidebar → <em>Encrypt folder…</em> to seal it. Files
            inside an encrypted folder are stored as ciphertext on disk;
            the folder is invisible to search, backlinks and the graph
            until you unlock it.
          </p>
        {:else}
          <ul class="vc-security-list" data-testid="settings-encrypted-list">
            {#each $encryptedFolders as folder}
              <li class="vc-security-row">
                <span class="vc-security-path">{folder.path}</span>
                <span class="vc-security-state">
                  {folder.state === "encrypting" ? "encrypting…" : "encrypted"}
                </span>
              </li>
            {/each}
          </ul>
          <p class="vc-settings-hint">
            Encrypted folders re-lock on app quit and on every vault
            reopen. There is no password recovery — forgetting the
            password means the files cannot be read.
          </p>
        {/if}
      </section>

      <!-- Section C — Tastaturkürzel (UI-05 / D-11 / #65) -->
      <section class="vc-settings-section" data-testid="settings-shortcuts">
        <h3 class="vc-settings-section-title">TASTATURKÜRZEL</h3>
        <table class="vc-shortcuts-table">
          <tbody>
            {#each shortcuts as s (s.id)}
              {@const isRecording = recordingFor === s.id}
              {@const def = defaultHotkey(s.id)}
              {@const isCustom = def ? !s.hotkey || !hotkeysEqual(def, s.hotkey) : Boolean(s.hotkey)}
              <tr>
                <td role="cell" class="vc-shortcut-action">{s.name}</td>
                <td role="cell" class="vc-shortcut-keys">
                  {#if isRecording}
                    <span class="vc-shortcut-recording" data-testid="shortcut-recording">
                      Drücke eine Tastenkombination…
                    </span>
                  {:else if s.hotkey}
                    <kbd>{formatShortcut(s.hotkey)}</kbd>
                  {:else}
                    <span class="vc-shortcut-disabled" title="Deaktiviert">—</span>
                  {/if}
                </td>
                <td role="cell" class="vc-shortcut-controls">
                  <button
                    type="button"
                    class="vc-shortcut-btn"
                    class:vc-shortcut-btn--active={isRecording}
                    onclick={() => (isRecording ? cancelRecording() : startRecording(s.id))}
                    aria-label={isRecording ? "Aufnahme abbrechen" : "Kürzel neu aufnehmen"}
                    title={isRecording ? "Aufnahme abbrechen" : "Kürzel neu aufnehmen"}
                    data-testid="shortcut-record-btn"
                    data-command-id={s.id}
                  ><Keyboard size={14} /></button>
                  <button
                    type="button"
                    class="vc-shortcut-btn"
                    onclick={() => onResetShortcut(s.id)}
                    disabled={!isCustom}
                    aria-label="Auf Standard zurücksetzen"
                    title="Auf Standard zurücksetzen"
                    data-testid="shortcut-reset-btn"
                    data-command-id={s.id}
                  ><RotateCcw size={14} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if recordError}
          <p class="vc-shortcut-error" role="alert" data-testid="shortcut-error">{recordError}</p>
        {/if}
      </section>

      <!-- Section — Build (#313) -->
      <section class="vc-settings-section" data-testid="settings-build">
        <h3 class="vc-settings-section-title">BUILD</h3>
        <div class="vc-settings-row">
          <label for="build-version">Version</label>
          <code
            id="build-version"
            class="vc-build-version"
            data-testid="settings-build-version"
            data-tooltip="Format: <commits-auf-main>-g<short-sha> · <commit-datum>. Höhere Commit-Zahl = neuer."
          >{__VC_BUILD_VERSION__}</code>
          <!-- Redundant hint for assistive tech — the CSS tooltip only fires on hover. -->
          <span class="vc-visually-hidden">
            Format: commits auf main, g, short sha, Commit-Datum. Höhere Commit-Zahl bedeutet neuer.
          </span>
        </div>
      </section>
    </div>
  </div>

  {#if pendingConflict}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="vc-conflict-backdrop vc-modal-scrim"
      role="presentation"
      onclick={resolveConflictCancel}
      data-testid="shortcut-conflict-backdrop"
    ></div>
    <div
      class="vc-conflict-modal vc-modal-surface"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="shortcut-conflict-title"
      data-testid="shortcut-conflict"
    >
      <h3 id="shortcut-conflict-title" class="vc-conflict-title">Tastenkürzel-Konflikt</h3>
      <p class="vc-conflict-body">
        <kbd>{formatShortcut(pendingConflict.newKey)}</kbd>
        ist bereits
        <strong>{pendingConflict.conflictName}</strong>
        zugewiesen. Soll die andere Zuweisung aufgehoben werden?
      </p>
      <div class="vc-conflict-actions">
        <button
          type="button"
          class="vc-conflict-btn"
          onclick={resolveConflictCancel}
          data-testid="shortcut-conflict-cancel"
        >Abbrechen</button>
        <button
          type="button"
          class="vc-conflict-btn vc-conflict-btn--primary"
          onclick={resolveConflictUnbind}
          data-testid="shortcut-conflict-unbind"
        >Zuweisung aufheben</button>
      </div>
    </div>
  {/if}

{/if}

<style>
  .vc-settings-backdrop {
    z-index: 300;
  }
  .vc-settings-modal {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    /* BUG-05.1: previously flat (min-height not set), sections crowded.
       Give the modal a generous default size so all three sections breathe. */
    width: 600px; min-height: 560px; max-height: 85vh;
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
    /* #385 — fallbacks equal width/height (byte-identical); coarse → 44×44. */
    min-width: var(--vc-hit-target, 28px);
    min-height: var(--vc-hit-target, 28px);
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
    /* #385 — fallback 36 equals `height` (byte-identical); coarse → 44px. */
    min-height: var(--vc-hit-target, 36px);
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
    /* #385 — fallback 32 equals `height` (byte-identical); coarse → 44px. */
    min-height: var(--vc-hit-target, 32px);
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

  /* Shared action button for settings rows. Mirrors the vault-switch
     button so neighbouring rows line up visually. */
  .vc-settings-btn {
    flex-shrink: 0;
    height: 32px;
    /* #385 — fallback 32 equals `height` (byte-identical); coarse → 44px. */
    min-height: var(--vc-hit-target, 32px);
    padding: 0 12px;
    font-size: 13px;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
  }
  .vc-settings-btn:hover:not(:disabled) {
    background: var(--color-accent-bg);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  /* #345 — encrypted folders list. */
  .vc-security-list {
    list-style: none;
    padding: 0;
    margin: 8px 0 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .vc-security-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
  }
  .vc-security-path {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .vc-security-state {
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .vc-settings-auto-lock-input {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--color-text-muted);
    font-size: 12px;
  }
  .vc-settings-auto-lock-input input {
    width: 72px;
    padding: 4px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: 13px;
  }

  .vc-settings-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  /* Section — Synchronisierung (UI-2) */
  .vc-sync-id-wrap {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .vc-sync-id {
    font-family: var(--vc-font-mono);
    font-size: 12px;
    color: var(--color-text-muted);
    user-select: text;
    padding: 2px 6px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .vc-sync-subhead {
    margin: 16px 0 8px 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
  }
  .vc-sync-peer-name {
    font-size: 13px;
    color: var(--color-text);
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc-sync-peer-meta {
    font-size: 11px;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }
  /* Vitruvius constraint: revoke is destructive but visually muted —
     border colour shifts to error on hover; never a red fill. */
  .vc-sync-revoke-btn:hover:not(:disabled) {
    border-color: var(--color-error);
    color: var(--color-error);
    background: var(--color-surface);
  }
  .vc-sync-pair-row { justify-content: flex-end; margin-top: 12px; margin-bottom: 0; }

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
  .vc-shortcut-recording {
    font-size: 12px;
    color: var(--color-accent);
    font-style: italic;
  }
  .vc-shortcut-disabled {
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .vc-shortcut-controls {
    width: 72px;
    text-align: right;
    white-space: nowrap;
    padding-right: 16px;
  }
  .vc-shortcut-btn {
    width: 26px; height: 26px;
    margin-left: 4px;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
  }
  .vc-shortcut-btn:hover:not(:disabled) {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .vc-shortcut-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .vc-shortcut-btn--active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .vc-shortcut-error {
    margin: 8px 16px 0;
    font-size: 12px;
    color: var(--color-danger, #c62828);
  }

  /* Build version (#313) */
  .vc-build-version {
    position: relative;
    font-family: var(--vc-font-mono);
    font-size: 12px;
    color: var(--color-text-muted);
    padding: 2px 6px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    user-select: text;
    cursor: help;
  }
  /* CSS tooltip — replaces native title= which WKWebView (Tauri) fails to render (#328). */
  .vc-build-version[data-tooltip]:hover::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    max-width: 360px;
    padding: 6px 10px;
    background: var(--color-surface-strong, #222);
    color: var(--color-text-on-strong, #fff);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-family: var(--vc-font-sans, inherit);
    font-size: 12px;
    line-height: 1.4;
    white-space: normal;
    width: max-content;
    pointer-events: none;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .vc-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Conflict modal (#65) */
  .vc-conflict-backdrop {
    z-index: 310;
  }
  .vc-conflict-modal {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 420px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    padding: 20px;
    z-index: 311;
  }
  .vc-conflict-title {
    margin: 0 0 12px 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
  }
  .vc-conflict-body {
    margin: 0 0 16px 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-text);
  }
  .vc-conflict-body kbd {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 6px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text);
    font-family: var(--vc-font-mono);
  }
  .vc-conflict-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .vc-conflict-btn {
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
  }
  .vc-conflict-btn:hover {
    background: var(--color-accent-bg);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .vc-conflict-btn--primary {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-surface);
  }
  .vc-conflict-btn--primary:hover {
    background: var(--color-accent);
    color: var(--color-surface);
    opacity: 0.9;
  }
</style>
