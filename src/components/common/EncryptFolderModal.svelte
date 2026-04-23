<script lang="ts">
  // #345 — two-field password modal for `encrypt_folder`. Reuses
  // the `UrlInputModal` geometry exactly (420 px, top 20%, vc-modal-surface)
  // plus a 3-segment strength meter under the confirmation field.
  // The meter is advisory — we do NOT block on weak passwords (user
  // decision in the Vitruvius brief).

  import { tick } from "svelte";

  import {
    passwordStrength,
    passwordStrengthFillCount,
    type PasswordStrength,
  } from "../../lib/passwordStrength";

  interface Props {
    open: boolean;
    folderLabel: string;
    onConfirm: (password: string) => void;
    onCancel: () => void;
  }

  let { open, folderLabel, onConfirm, onCancel }: Props = $props();

  let pw = $state("");
  let confirm = $state("");
  let inputEl = $state<HTMLInputElement | undefined>();

  $effect(() => {
    if (open) {
      pw = "";
      confirm = "";
      void tick().then(() => inputEl?.focus());
    }
  });

  const strength: PasswordStrength = $derived(passwordStrength(pw));
  const fill = $derived(passwordStrengthFillCount(strength));
  const match = $derived(pw.length > 0 && pw === confirm);
  const mismatch = $derived(confirm.length > 0 && pw !== confirm);

  const strengthLabel = $derived.by(() => {
    switch (strength) {
      case "empty": return "";
      case "weak": return "Weak";
      case "ok": return "OK";
      case "strong": return "Strong";
    }
  });

  function submit() {
    if (!match) return;
    onConfirm(pw);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-encrypt-modal-backdrop vc-modal-scrim"
    onclick={onCancel}
    role="presentation"
    data-testid="encrypt-folder-backdrop"
  ></div>
  <div
    class="vc-encrypt-modal vc-modal-surface"
    role="dialog"
    aria-modal="true"
    aria-label="Encrypt folder"
    data-testid="encrypt-folder-modal"
  >
    <div class="vc-encrypt-modal-header">
      <span class="vc-encrypt-modal-title">Encrypt folder</span>
      <span class="vc-encrypt-modal-subtitle">{folderLabel}</span>
      <p class="vc-encrypt-modal-warning">
        Files in this folder will be sealed on disk. Obsidian and other
        readers will not be able to open them. Forgetting the password
        means the files cannot be recovered.
      </p>
    </div>
    <label class="vc-encrypt-modal-label">
      Password
      <input
        bind:this={inputEl}
        bind:value={pw}
        onkeydown={onKey}
        type="password"
        class="vc-encrypt-modal-input"
        autocomplete="new-password"
        spellcheck="false"
        data-testid="encrypt-folder-password"
      />
    </label>
    <div class="vc-encrypt-modal-strength" data-testid="encrypt-folder-strength">
      <div class="vc-encrypt-modal-strength-bar">
        <span class:vc-encrypt-modal-strength-seg-on={fill >= 1}></span>
        <span class:vc-encrypt-modal-strength-seg-on={fill >= 2}></span>
        <span class:vc-encrypt-modal-strength-seg-on={fill >= 3}></span>
      </div>
      <span class="vc-encrypt-modal-strength-label">{strengthLabel}</span>
    </div>
    <label class="vc-encrypt-modal-label">
      Confirm password
      <input
        bind:value={confirm}
        onkeydown={onKey}
        type="password"
        class="vc-encrypt-modal-input"
        class:vc-encrypt-modal-input-error={mismatch}
        autocomplete="new-password"
        spellcheck="false"
        aria-invalid={mismatch ? "true" : "false"}
        data-testid="encrypt-folder-confirm"
      />
    </label>
    {#if mismatch}
      <div class="vc-encrypt-modal-error" role="alert" data-testid="encrypt-folder-mismatch">
        Passwords do not match.
      </div>
    {/if}
    <div class="vc-encrypt-modal-actions">
      <button
        type="button"
        class="vc-encrypt-modal-cancel"
        onclick={onCancel}
      >Cancel</button>
      <button
        type="button"
        class="vc-encrypt-modal-ok"
        onclick={submit}
        disabled={!match}
        data-testid="encrypt-folder-confirm-button"
      >Encrypt</button>
    </div>
  </div>
{/if}

<style>
  .vc-encrypt-modal-backdrop { z-index: 200; }
  .vc-encrypt-modal {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 420px;
    max-width: calc(100vw - 32px);
    z-index: 201;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }
  .vc-encrypt-modal-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .vc-encrypt-modal-title { font-weight: 600; font-size: 13px; color: var(--color-text); }
  .vc-encrypt-modal-subtitle {
    font-size: 12px;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc-encrypt-modal-warning {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--color-text-muted);
    line-height: 1.4;
  }
  .vc-encrypt-modal-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .vc-encrypt-modal-input {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: 14px;
    outline: none;
  }
  .vc-encrypt-modal-input:focus { border-color: var(--color-accent); }
  .vc-encrypt-modal-input-error,
  .vc-encrypt-modal-input-error:focus {
    border-color: var(--color-error, #d14343);
  }
  .vc-encrypt-modal-strength {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .vc-encrypt-modal-strength-bar {
    display: flex;
    gap: 4px;
    flex: 1;
  }
  .vc-encrypt-modal-strength-bar span {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--color-border);
  }
  .vc-encrypt-modal-strength-seg-on {
    background: var(--color-accent) !important;
  }
  .vc-encrypt-modal-strength-label {
    min-width: 40px;
    text-align: right;
  }
  .vc-encrypt-modal-error { font-size: 12px; color: var(--color-error, #d14343); }
  .vc-encrypt-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .vc-encrypt-modal-cancel,
  .vc-encrypt-modal-ok {
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
  }
  .vc-encrypt-modal-ok {
    background: var(--color-accent);
    color: var(--color-accent-contrast, #fff);
    border-color: var(--color-accent);
  }
  .vc-encrypt-modal-ok:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
