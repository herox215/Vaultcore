<script lang="ts">
  // Single-field URL prompt used by the canvas "Add link node" context-menu
  // action (#166). Enter confirms, Escape / backdrop cancel. The consumer
  // decides what to do with the URL — the modal only collects it.

  import { tick } from "svelte";

  interface Props {
    open: boolean;
    initial?: string;
    onConfirm: (url: string) => void;
    onCancel: () => void;
  }

  let { open, initial = "https://", onConfirm, onCancel }: Props = $props();

  let value = $state("");
  let inputEl = $state<HTMLInputElement | undefined>();

  $effect(() => {
    if (open) {
      value = initial;
      void tick().then(() => {
        inputEl?.focus();
        inputEl?.select();
      });
    }
  });

  function submit() {
    const v = value.trim();
    if (!v) {
      onCancel();
      return;
    }
    onConfirm(v);
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
    class="vc-url-modal-backdrop vc-modal-scrim"
    onclick={onCancel}
    role="presentation"
  ></div>
  <div class="vc-url-modal vc-modal-surface" role="dialog" aria-modal="true" aria-label="Link hinzufügen">
    <label class="vc-url-modal-label">
      URL
      <input
        bind:this={inputEl}
        bind:value={value}
        onkeydown={onKey}
        type="url"
        class="vc-url-modal-input"
        autocomplete="off"
        spellcheck="false"
      />
    </label>
    <div class="vc-url-modal-actions">
      <button
        type="button"
        class="vc-url-modal-cancel"
        onclick={onCancel}
      >Cancel</button>
      <button
        type="button"
        class="vc-url-modal-ok"
        onclick={submit}
      >OK</button>
    </div>
  </div>
{/if}

<style>
  .vc-url-modal-backdrop {
    z-index: 200;
  }

  .vc-url-modal {
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

  .vc-url-modal-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .vc-url-modal-input {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: 14px;
    outline: none;
  }

  .vc-url-modal-input:focus {
    border-color: var(--color-accent);
  }

  .vc-url-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .vc-url-modal-cancel,
  .vc-url-modal-ok {
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
  }

  .vc-url-modal-ok {
    background: var(--color-accent);
    color: var(--color-accent-contrast, #fff);
    border-color: var(--color-accent);
  }
</style>
