<script lang="ts">
  import { X } from "lucide-svelte";

  interface Props {
    onSearch: (query: string) => void;
    disabled: boolean;
  }

  let { onSearch, disabled }: Props = $props();

  let value = $state("");
  let inputEl: HTMLInputElement | undefined = $state();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    value = target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onSearch(value);
    }, 200);
  }

  function handleClear() {
    value = "";
    clearTimeout(debounceTimer);
    onSearch("");
    inputEl?.focus();
  }

  export function focus() {
    inputEl?.focus();
  }
</script>

<div class="vc-search-input-wrapper">
  <input
    bind:this={inputEl}
    type="search"
    role="searchbox"
    aria-label="Volltextsuche"
    aria-busy={disabled}
    placeholder='Suchen... (AND, OR, NOT, "phrase")'
    class="vc-search-input"
    class:vc-search-input--disabled={disabled}
    {disabled}
    {value}
    oninput={handleInput}
  />
  {#if value.length > 0}
    <button
      class="vc-search-clear-btn"
      onclick={handleClear}
      aria-label="Suche löschen"
      type="button"
    >
      <X size={16} strokeWidth={1.5} />
    </button>
  {/if}
</div>

<style>
  .vc-search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    padding: 8px 12px;
    flex-shrink: 0;
  }

  .vc-search-input {
    width: 100%;
    height: 36px;
    padding: 0 32px 0 16px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 14px;
    font-family: var(--vc-font-body);
    background: var(--color-surface);
    color: var(--color-text);
    outline: none;
    /* Remove browser default search input styling */
    -webkit-appearance: none;
    appearance: none;
  }

  .vc-search-input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .vc-search-input--disabled,
  .vc-search-input:disabled {
    cursor: not-allowed;
    background: var(--color-border);
    color: var(--color-text-muted);
  }

  .vc-search-clear-btn {
    position: absolute;
    right: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0;
    border-radius: 2px;
  }

  .vc-search-clear-btn:hover {
    color: var(--color-text);
    background: var(--color-accent-bg);
  }
</style>
