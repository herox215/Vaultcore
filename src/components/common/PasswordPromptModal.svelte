<script lang="ts">
  // #345 — single-field password prompt for `unlock_folder`. Reuses
  // the `UrlInputModal` geometry (420 px, top 20%, vc-modal-surface).
  //
  // Wrong-password state: when `error === "wrong"` the input border
  // flips to --color-error, a screenreader-announced `role="alert"`
  // row appears below, and the input stays focused so the user can
  // retype without reaching for the mouse.

  import { tick } from "svelte";

  interface Props {
    open: boolean;
    folderLabel: string;
    /** One-word error kind; rendered with a local copy table. */
    error?: "wrong" | "crypto" | null;
    onConfirm: (password: string) => void;
    onCancel: () => void;
  }

  let { open, folderLabel, error = null, onConfirm, onCancel }: Props = $props();

  let value = $state("");
  let inputEl = $state<HTMLInputElement | undefined>();

  $effect(() => {
    if (open) {
      value = "";
      void tick().then(() => inputEl?.focus());
    }
  });

  $effect(() => {
    if (error === "wrong") {
      void tick().then(() => inputEl?.focus());
    }
  });

  let submitting = $state(false);

  function submit() {
    // Enter on an empty input is a no-op, not a cancel — closing the
    // modal on accidental Enter would be a foot-gun for users who
    // haven't finished typing. Explicit cancel is Escape / backdrop.
    if (!value || submitting) return;
    submitting = true;
    onConfirm(value);
  }

  // Reset the submitting guard when the modal is re-used (wrong-password
  // retry or re-open after close).
  $effect(() => {
    if (open) {
      submitting = false;
    }
  });
  $effect(() => {
    if (error !== null) {
      submitting = false;
    }
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  const errorCopy = $derived.by(() => {
    if (error === "wrong") return "Wrong password.";
    if (error === "crypto") return "Could not decrypt this folder. The vault may be corrupted.";
    return "";
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-password-modal-backdrop vc-modal-scrim"
    onclick={onCancel}
    role="presentation"
    data-testid="password-prompt-backdrop"
  ></div>
  <div
    class="vc-password-modal vc-modal-surface"
    role="dialog"
    aria-modal="true"
    aria-label="Unlock encrypted folder"
    data-testid="password-prompt"
  >
    <div class="vc-password-modal-header">
      <span class="vc-password-modal-title">Unlock folder</span>
      <span class="vc-password-modal-subtitle">{folderLabel}</span>
    </div>
    <label class="vc-password-modal-label">
      Password
      <input
        bind:this={inputEl}
        bind:value={value}
        onkeydown={onKey}
        type="password"
        class="vc-password-modal-input"
        class:vc-password-modal-input-error={error !== null}
        autocomplete="current-password"
        spellcheck="false"
        aria-invalid={error !== null ? "true" : "false"}
        data-testid="password-prompt-input"
      />
    </label>
    {#if error}
      <div class="vc-password-modal-error" role="alert" data-testid="password-prompt-error">
        {errorCopy}
      </div>
    {/if}
    <div class="vc-password-modal-actions">
      <button
        type="button"
        class="vc-password-modal-cancel"
        onclick={onCancel}
      >Cancel</button>
      <button
        type="button"
        class="vc-password-modal-ok"
        onclick={submit}
        disabled={!value || submitting}
        data-testid="password-prompt-confirm"
      >{submitting ? "Unlocking…" : "Unlock"}</button>
    </div>
  </div>
{/if}

<style>
  .vc-password-modal-backdrop { z-index: 200; }
  .vc-password-modal {
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
  .vc-password-modal-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .vc-password-modal-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--color-text);
  }
  .vc-password-modal-subtitle {
    font-size: 12px;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc-password-modal-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .vc-password-modal-input {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: 14px;
    outline: none;
  }
  .vc-password-modal-input:focus { border-color: var(--color-accent); }
  .vc-password-modal-input-error,
  .vc-password-modal-input-error:focus {
    border-color: var(--color-error, #d14343);
  }
  .vc-password-modal-error {
    font-size: 12px;
    color: var(--color-error, #d14343);
  }
  .vc-password-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .vc-password-modal-cancel,
  .vc-password-modal-ok {
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
  }
  .vc-password-modal-ok {
    background: var(--color-accent);
    color: var(--color-accent-contrast, #fff);
    border-color: var(--color-accent);
  }
  .vc-password-modal-ok:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
