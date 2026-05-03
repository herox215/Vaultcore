<script lang="ts">
  // UI-3 — 4-step pairing modal (LAN sync). Stacked over SettingsModal at
  // z-index 310/311, mirroring the shortcut-conflict modal (#65).
  //
  // Steps:
  //   1. Role selection — initiator (zeigt PIN) vs responder (gibt PIN ein).
  //   2. PIN exchange — initiator displays XXX–XXX + QR; responder fills 6 boxes.
  //   3. Key confirmation — both sides read out fingerprints, agree.
  //   4. Vault grant — initiator picks which vaults the new peer may sync.
  //
  // All actions go through `syncStore` (UI-1). The component never invokes
  // Tauri directly. Bridge engineer note: `pairing_step` returns
  // `awaiting_peer` until raw_keys arrive in the session, and
  // `pairing_confirm` errors when raw_keys are absent — this is treated as
  // "still verifying" not as a security signal.
  //
  // a11y notes:
  //   - Countdown announces every 10 s (snap-to-nearest-10) on a polite
  //     `aria-live` wrapper; the per-second readout has `aria-live="off"`
  //     so screen readers don't drown in updates (issue from Vitruvius).
  //   - Lockout copy is symmetric — never discloses which side typed wrong
  //     (a leak there would let an attacker who watches one side infer
  //     state from copy alone).

  import { onMount, onDestroy, tick } from "svelte";
  import {
    pendingPairingSession,
    startInitiator,
    startResponder,
    stepPairing,
    confirmPairing,
    cancelPairing,
    pairingGrantVault,
  } from "../../store/syncStore";
  import type { VaultRef, PairingStep } from "../../ipc/commands";

  interface Props {
    open: boolean;
    /** Vaults the local device owns and can offer the new peer. */
    vaults: VaultRef[];
    /** Element to return focus to after close (the "Neues Gerät koppeln…"
     *  button in SettingsModal). */
    triggerEl?: HTMLElement | null;
    /** Local device name for the key-confirmation readout. */
    selfDeviceName?: string;
    onClose: () => void;
  }

  let {
    open,
    vaults,
    triggerEl = null,
    selfDeviceName = "",
    onClose,
  }: Props = $props();

  // ── State ─────────────────────────────────────────────────────────────

  type Role = "initiator" | "responder";

  let step = $state<1 | 2 | 3 | 4>(1);
  let role = $state<Role>("initiator");
  let pinDigits = $state<string[]>(["", "", "", "", "", ""]);
  let attemptsRemaining = $state<number | null>(null);
  let pinError = $state<string | null>(null);
  let lockedOut = $state(false);
  let qrDataUrl = $state<string | null>(null);
  let grantedVaultIds = $state<Set<string>>(new Set());
  let submitting = $state(false);

  // Field refs for the responder 6-box input.
  let pinFieldEls: HTMLInputElement[] = $state([]);
  let firstRadioEl = $state<HTMLInputElement | null>(null);

  // Subscription to the pending session.
  let sessionPin = $state<string | null>(null);
  let sessionExpiresAt = $state<number | null>(null);
  let lastStep = $state<PairingStep | null>(null);
  const _unsub = pendingPairingSession.subscribe((s) => {
    sessionPin = s?.pin ?? null;
    sessionExpiresAt = s?.expires_at_unix ?? null;
    lastStep = s?.last_step ?? null;
    if (!s) return;
    // Reflect the store role onto local state so the modal can rehydrate
    // mid-flow (e.g. closed and reopened, or session arrived while still
    // on step 1).
    role = s.role;
    // A session exists → we're past role-selection. Advance to step 2
    // unless we've already moved past it.
    if (step === 1) step = 2;
    // When the engine signals awaiting_confirmation, advance into step 3
    // automatically — we already have a peer_fingerprint to show.
    if (
      step <= 2 &&
      s.last_step?.kind === "awaiting_confirmation" &&
      s.last_step?.peer_fingerprint
    ) {
      step = 3;
    }
  });

  // ── Countdown ─────────────────────────────────────────────────────────
  //
  // Plain `setInterval(1000)` so the per-second readout updates smoothly;
  // the announced (a11y) value is derived to the nearest 10 so AT users
  // get a calm cadence.
  let nowMs = $state(Date.now());
  let interval: ReturnType<typeof setInterval> | null = null;
  const secondsLeft = $derived(
    sessionExpiresAt == null ? 0 : Math.max(0, sessionExpiresAt - Math.floor(nowMs / 1000)),
  );
  const announcedTime = $derived(Math.round(secondsLeft / 10) * 10);

  function startCountdown() {
    stopCountdown();
    interval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  }
  function stopCountdown() {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  onMount(async () => {
    if (open) {
      await tick();
      firstRadioEl?.focus();
    }
    startCountdown();
  });

  onDestroy(() => {
    stopCountdown();
    try {
      _unsub();
    } catch {
      /* swallow */
    }
  });

  $effect(() => {
    if (!open) {
      // Reset to a known starting state when the parent closes the modal.
      step = 1;
      role = "initiator";
      pinDigits = ["", "", "", "", "", ""];
      attemptsRemaining = null;
      pinError = null;
      lockedOut = false;
      qrDataUrl = null;
      grantedVaultIds = new Set();
      submitting = false;
      return;
    }
    // Open: focus first interactive on step 1.
    void tick().then(() => {
      if (step === 1) firstRadioEl?.focus();
    });
  });

  // ── Step transitions ──────────────────────────────────────────────────

  async function advanceFromRole() {
    if (role === "initiator") {
      const dto = await startInitiator();
      step = 2;
      // Lazy import keeps the QR lib out of the main bundle until needed.
      try {
        const mod = await import("qrcode");
        const fn = (mod.default?.toDataURL ?? mod.toDataURL) as
          | ((text: string) => Promise<string>)
          | undefined;
        if (fn) qrDataUrl = await fn(dto.pin);
      } catch {
        qrDataUrl = null;
      }
    } else {
      step = 2;
      // Focus the first PIN box after the DOM updates.
      await tick();
      pinFieldEls[0]?.focus();
    }
  }

  async function submitResponderPin() {
    const joined = pinDigits.join("");
    if (joined.length !== 6 || lockedOut || submitting) return;
    submitting = true;
    try {
      await startResponder(joined);
      const result = await stepPairing(joined);
      handleStepResult(result);
    } catch (e) {
      pinError = "Verbindung fehlgeschlagen.";
    } finally {
      submitting = false;
    }
  }

  function handleStepResult(result: PairingStep) {
    if (result.kind === "failed") {
      attemptsRemaining = result.attempts_remaining;
      if ((result.attempts_remaining ?? 0) <= 0) {
        lockedOut = true;
        pinError = null;
      } else {
        pinError = `Falscher PIN — ${result.attempts_remaining} Versuche verbleibend.`;
        // Wipe digits so the user can retype.
        pinDigits = ["", "", "", "", "", ""];
        void tick().then(() => pinFieldEls[0]?.focus());
      }
    } else if (result.kind === "awaiting_confirmation") {
      step = 3;
    }
    // awaiting_peer / complete: store subscription path handles the rest.
  }

  async function onConfirmKeys() {
    if (submitting) return;
    submitting = true;
    try {
      await confirmPairing();
      // Initiator drives step 4 (vault grants). Responder is done after
      // confirm — the initiator will issue grants later via Settings.
      if (role === "initiator") {
        step = 4;
      } else {
        finishAndClose();
      }
    } catch (e) {
      pinError = "Schlüsselbestätigung fehlgeschlagen.";
    } finally {
      submitting = false;
    }
  }

  async function onRejectKeys() {
    await doCancel();
  }

  async function onDone() {
    if (grantedVaultIds.size === 0 || submitting) return;
    submitting = true;
    try {
      // Issue grants over the active pairing session's open Noise
      // channel. Both sides must be in step 4 simultaneously — the
      // engine call is symmetric and blocks waiting for the peer.
      for (const vaultId of grantedVaultIds) {
        await pairingGrantVault(vaultId, "read+write");
      }
      finishAndClose();
    } catch (e) {
      pinError = "Vault-Freigabe fehlgeschlagen.";
    } finally {
      submitting = false;
    }
  }

  function finishAndClose() {
    onClose();
    // Return focus to the trigger button.
    void tick().then(() => triggerEl?.focus());
  }

  async function doCancel() {
    try {
      await cancelPairing();
    } finally {
      onClose();
      void tick().then(() => triggerEl?.focus());
    }
  }

  // ── PIN field interactions ────────────────────────────────────────────

  function onPinInput(idx: number, e: Event) {
    if (lockedOut) return;
    const target = e.target as HTMLInputElement;
    // Strip non-digits and clamp to length 1.
    const v = target.value.replace(/\D/g, "").slice(-1);
    target.value = v;
    pinDigits[idx] = v;
    pinDigits = [...pinDigits];
    if (v && idx < 5) {
      pinFieldEls[idx + 1]?.focus();
    }
    if (v && idx === 5 && pinDigits.every((d) => d.length === 1)) {
      void submitResponderPin();
    }
  }

  function onPinKeyDown(idx: number, e: KeyboardEvent) {
    if (lockedOut) return;
    if (e.key === "Backspace" && pinDigits[idx] === "" && idx > 0) {
      e.preventDefault();
      pinFieldEls[idx - 1]?.focus();
      return;
    }
    if (e.key === "ArrowLeft" && idx > 0) {
      e.preventDefault();
      pinFieldEls[idx - 1]?.focus();
    } else if (e.key === "ArrowRight" && idx < 5) {
      e.preventDefault();
      pinFieldEls[idx + 1]?.focus();
    }
  }

  function onPinPaste(e: ClipboardEvent) {
    if (lockedOut) return;
    const data = e.clipboardData?.getData("text") ?? "";
    const digits = data.replace(/\D/g, "").slice(0, 6);
    if (digits.length === 0) return;
    e.preventDefault();
    const next = pinDigits.slice();
    for (let i = 0; i < 6; i++) next[i] = digits[i] ?? "";
    pinDigits = next;
    // Mirror to the DOM (some test runners read .value back).
    for (let i = 0; i < 6; i++) {
      const el = pinFieldEls[i];
      if (el) el.value = next[i] ?? "";
    }
    const lastFilled = digits.length - 1;
    pinFieldEls[Math.min(lastFilled + 1, 5)]?.focus();
    if (digits.length === 6) void submitResponderPin();
  }

  // ── Global Escape ─────────────────────────────────────────────────────

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      void doCancel();
    }
  }

  $effect(() => {
    if (open) {
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
  });

  // ── Display helpers ───────────────────────────────────────────────────

  const formattedPin = $derived.by(() => {
    const pin = sessionPin ?? "";
    if (pin.length !== 6) return pin;
    // U+2013 EN DASH between the two triplets.
    return `${pin.slice(0, 3)}–${pin.slice(3, 6)}`;
  });

  function shortFp(fp: string | null | undefined): string {
    if (!fp) return "";
    return `${fp.slice(0, 12)}…`;
  }

  function toggleVault(id: string) {
    const next = new Set(grantedVaultIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    grantedVaultIds = next;
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-pairing-backdrop vc-modal-scrim"
    role="presentation"
    onclick={() => doCancel()}
    data-testid="pairing-backdrop"
  ></div>
  <div
    class="vc-pairing-modal vc-modal-surface"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pairing-title"
    data-testid="pairing-modal"
  >
    <h3 id="pairing-title" class="vc-pairing-title">
      {#if step === 1}Neues Gerät koppeln{/if}
      {#if step === 2 && role === "initiator"}PIN auf dem anderen Gerät eingeben{/if}
      {#if step === 2 && role === "responder"}PIN vom anderen Gerät eingeben{/if}
      {#if step === 3}Schlüssel bestätigen{/if}
      {#if step === 4}Vaults freigeben{/if}
    </h3>

    {#if step === 1}
      <div class="vc-pairing-role" role="radiogroup" aria-label="Rolle wählen">
        <label class="vc-theme-radio" class:vc-theme-radio--active={role === "initiator"}>
          <input
            type="radio"
            name="vc-pairing-role"
            value="initiator"
            checked={role === "initiator"}
            bind:this={firstRadioEl}
            onchange={() => (role = "initiator")}
          />
          <span>Dieses Gerät zeigt den PIN</span>
        </label>
        <label class="vc-theme-radio" class:vc-theme-radio--active={role === "responder"}>
          <input
            type="radio"
            name="vc-pairing-role"
            value="responder"
            checked={role === "responder"}
            onchange={() => (role = "responder")}
          />
          <span>Dieses Gerät gibt den PIN ein</span>
        </label>
      </div>
      <div class="vc-pairing-actions">
        <button
          type="button"
          class="vc-password-modal-cancel"
          onclick={() => doCancel()}
        >Abbrechen</button>
        <button
          type="button"
          class="vc-password-modal-ok"
          onclick={advanceFromRole}
          data-testid="pairing-next"
        >Weiter</button>
      </div>
    {:else if step === 2 && role === "initiator"}
      <div class="vc-pairing-pin-display" data-testid="pairing-initiator-pin">
        {formattedPin}
      </div>
      <div
        class="vc-pairing-countdown"
        aria-live="polite"
        data-testid="pairing-countdown-live"
      >{announcedTime}</div>
      <div class="vc-pairing-countdown-text" aria-live="off" data-testid="pairing-countdown-inner">
        Läuft ab in {secondsLeft} Sekunden
      </div>
      {#if qrDataUrl}
        <img src={qrDataUrl} alt="QR-Code mit PIN" class="vc-pairing-qr" width="160" height="160" />
      {/if}
      <div class="vc-pairing-actions">
        <button
          type="button"
          class="vc-password-modal-cancel"
          onclick={() => doCancel()}
        >Abbrechen</button>
      </div>
    {:else if step === 2 && role === "responder"}
      {#if lockedOut}
        <div class="vc-pairing-lockout" role="alert" data-testid="pairing-lockout">
          Gesperrt — 60 Sekunden warten
        </div>
      {:else}
        <div class="vc-pairing-pin-input" onpaste={onPinPaste}>
          {#each pinDigits as _digit, i (i)}
            <input
              bind:this={pinFieldEls[i]}
              type="text"
              maxlength="1"
              inputmode="numeric"
              autocomplete="one-time-code"
              class="vc-pairing-pin-field"
              data-testid={`pairing-pin-field-${i}`}
              value={pinDigits[i]}
              oninput={(e) => onPinInput(i, e)}
              onkeydown={(e) => onPinKeyDown(i, e)}
            />
          {/each}
        </div>
        {#if pinError}
          <div class="vc-pairing-pin-error" role="alert" data-testid="pairing-pin-error">
            {pinError}
          </div>
        {/if}
      {/if}
      <div class="vc-pairing-actions">
        <button
          type="button"
          class="vc-password-modal-cancel"
          onclick={() => doCancel()}
        >Abbrechen</button>
      </div>
    {:else if step === 3}
      <div class="vc-pairing-keys">
        <div class="vc-pairing-key-row">
          <span class="vc-pairing-key-label">Dieses Gerät</span>
          <span class="vc-pairing-key-name">{selfDeviceName || "—"}</span>
          <span class="vc-pairing-key-fp">{shortFp(lastStep?.peer_fingerprint)}</span>
        </div>
        <div class="vc-pairing-key-row">
          <span class="vc-pairing-key-label">Anderes Gerät</span>
          <span class="vc-pairing-key-fp">{shortFp(lastStep?.peer_fingerprint)}</span>
        </div>
      </div>
      <div class="vc-pairing-actions">
        <button
          type="button"
          class="vc-password-modal-cancel"
          onclick={onRejectKeys}
          data-testid="pairing-key-reject"
        >Ablehnen</button>
        <button
          type="button"
          class="vc-password-modal-ok"
          onclick={onConfirmKeys}
          data-testid="pairing-key-confirm"
        >Bestätigen</button>
      </div>
    {:else if step === 4}
      <ul class="vc-pairing-vaults" role="list">
        {#each vaults as v (v.id)}
          <li class="vc-pairing-vault">
            <label class="vc-snippets-toggle">
              <input
                type="checkbox"
                data-vault-id={v.id}
                checked={grantedVaultIds.has(v.id)}
                onchange={() => toggleVault(v.id)}
              />
              <span class="vc-snippets-toggle-track" aria-hidden="true">
                <span class="vc-snippets-toggle-thumb"></span>
              </span>
              <span class="vc-pairing-vault-name">{v.name}</span>
            </label>
          </li>
        {/each}
      </ul>
      <div class="vc-pairing-actions">
        <button
          type="button"
          class="vc-password-modal-cancel"
          onclick={() => doCancel()}
        >Abbrechen</button>
        <button
          type="button"
          class="vc-password-modal-ok"
          onclick={onDone}
          disabled={grantedVaultIds.size === 0 || submitting}
          data-testid="pairing-done"
        >Fertig</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .vc-pairing-backdrop {
    z-index: 310;
  }
  .vc-pairing-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 480px;
    max-width: calc(100vw - 32px);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    z-index: 311;
  }
  .vc-pairing-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
  }
  .vc-pairing-role {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .vc-pairing-pin-display {
    font-family: var(--vc-font-mono);
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-align: center;
    color: var(--color-text);
  }
  .vc-pairing-countdown {
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: center;
  }
  .vc-pairing-countdown-text {
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: center;
  }
  .vc-pairing-qr {
    align-self: center;
    image-rendering: pixelated;
  }
  .vc-pairing-pin-input {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .vc-pairing-pin-field {
    width: 40px;
    height: 32px;
    text-align: center;
    font-family: var(--vc-font-mono);
    font-size: 18px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    outline: none;
  }
  .vc-pairing-pin-field:focus {
    border-color: var(--color-accent);
  }
  .vc-pairing-pin-error,
  .vc-pairing-lockout {
    font-size: 12px;
    color: var(--color-error, #d14343);
    text-align: center;
  }
  .vc-pairing-keys {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
  }
  .vc-pairing-key-row {
    display: grid;
    grid-template-columns: 100px 1fr auto;
    gap: 8px;
    align-items: center;
  }
  .vc-pairing-key-label {
    color: var(--color-text-muted);
  }
  .vc-pairing-key-name {
    color: var(--color-text);
  }
  .vc-pairing-key-fp {
    font-family: var(--vc-font-mono);
    color: var(--color-text);
  }
  .vc-pairing-vaults {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .vc-pairing-vault-name {
    margin-left: 8px;
    font-size: 13px;
    color: var(--color-text);
  }
  .vc-pairing-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
