<script lang="ts">
  import { onMount } from "svelte";
  import { renameFile, deleteFile } from "../../ipc/commands";
  import { toastStore } from "../../store/toastStore";
  import { isVaultError, vaultErrorCopy } from "../../types/errors";

  interface Props {
    currentName: string;
    oldPath: string;
    isNewFile?: boolean;
    onConfirm: (newPath: string, linkCount: number) => void;
    onCancel: () => void;
  }

  let { currentName, oldPath, isNewFile = false, onConfirm, onCancel }: Props = $props();

  let inputEl: HTMLInputElement | null = null;
  let value = $state(currentName);
  let validationError = $state<string | null>(null);
  let confirming = $state(false);

  onMount(() => {
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });

  function validate(name: string): string | null {
    if (name.includes("/") || name.includes("\\")) {
      return "Filename cannot contain / or \\";
    }
    if (!name.trim()) {
      return "Filename cannot be empty";
    }
    return null;
  }

  function ensureMdExtension(name: string): string {
    // Only enforce .md extension if the original file was .md
    if (currentName.toLowerCase().endsWith(".md")) {
      if (!name.toLowerCase().endsWith(".md")) {
        return name + ".md";
      }
    }
    return name;
  }

  async function handleConfirm() {
    if (confirming) return;
    const trimmed = value.trim();
    const err = validate(trimmed);
    if (err) {
      validationError = err;
      return;
    }
    validationError = null;
    const finalName = ensureMdExtension(trimmed);
    confirming = true;
    try {
      const result = await renameFile(oldPath, finalName);
      onConfirm(result.newPath, result.linkCount);
    } catch (e) {
      const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
      // On error, cancel
      if (isNewFile) {
        try { await deleteFile(oldPath); } catch { /* ignore */ }
      }
      onCancel();
    } finally {
      confirming = false;
    }
  }

  async function handleCancel() {
    if (isNewFile) {
      try { await deleteFile(oldPath); } catch { /* ignore */ }
    }
    onCancel();
  }

  function handleKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      void handleCancel();
    }
  }

  function handleBlur() {
    void handleConfirm();
  }

  function handleInput(e: Event) {
    value = (e.target as HTMLInputElement).value;
    validationError = null;
  }
</script>

<div class="vc-inline-rename">
  <input
    bind:this={inputEl}
    type="text"
    class="vc-rename-input"
    {value}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onblur={handleBlur}
    aria-label="Rename file"
    disabled={confirming}
  />
  {#if validationError}
    <p class="vc-rename-error" role="alert">{validationError}</p>
  {/if}
</div>

<style>
  .vc-inline-rename {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .vc-rename-input {
    width: 100%;
    height: 24px;
    font-size: 14px;
    font-weight: 400;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 0 4px;
    box-sizing: border-box;
    outline: none;
  }

  .vc-rename-input:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-accent-bg);
  }

  .vc-rename-error {
    font-size: 12px;
    color: var(--color-error);
    margin: 2px 0 0 0;
    line-height: 1.3;
  }
</style>
