<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { vaultStore } from "../../store/vaultStore";
  import { activeViewStore } from "../../store/activeViewStore";
  import { listTemplates, readTemplate } from "../../ipc/commands";
  import { substituteTemplateVars } from "../../lib/templateSubstitution";
  import { toastStore } from "../../store/toastStore";
  import { tabStore } from "../../store/tabStore";
  import type { EditorView } from "@codemirror/view";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let query = $state("");
  let templates = $state<string[]>([]);
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>();

  let currentVaultPath: string | null = null;
  const unsubVault = vaultStore.subscribe((s) => {
    currentVaultPath = s.currentPath;
  });

  let activeView: EditorView | null = null;
  const unsubView = activeViewStore.subscribe((s) => {
    activeView = s.view;
  });

  onDestroy(() => {
    unsubVault();
    unsubView();
  });

  const filtered = $derived(
    query.trim()
      ? templates.filter((t) =>
          t.toLowerCase().includes(query.toLowerCase()),
        )
      : templates,
  );

  $effect(() => {
    if (open) {
      query = "";
      selectedIndex = 0;
      void loadTemplates();
      void tick().then(() => inputEl?.focus());
    }
  });

  async function loadTemplates() {
    if (!currentVaultPath) return;
    try {
      templates = await listTemplates(currentVaultPath);
    } catch {
      templates = [];
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const count = filtered.length;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (count === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % count;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + count) % count;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filtered[selectedIndex];
      if (selected) void selectTemplate(selected);
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  function activeNoteTitle(): string {
    const active = tabStore.getActiveTab();
    if (!active) return "";
    const filename = active.filePath.split("/").pop() ?? "";
    return filename.replace(/\.md$/i, "");
  }

  async function selectTemplate(filename: string) {
    if (!currentVaultPath) return;
    try {
      const raw = await readTemplate(currentVaultPath, filename);
      const content = substituteTemplateVars(raw, activeNoteTitle());
      insertAtCursor(content);
      onClose();
    } catch {
      toastStore.push({
        variant: "error",
        message: `Vorlage "${filename}" konnte nicht geladen werden.`,
      });
    }
  }

  function insertAtCursor(text: string) {
    if (!activeView) {
      toastStore.push({
        variant: "error",
        message: "Kein Editor aktiv — öffne zuerst eine Notiz.",
      });
      return;
    }
    const pos = activeView.state.selection.main.head;
    activeView.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    activeView.focus();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-tp-backdrop vc-modal-scrim"
    onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
  >
    <div
      class="vc-tp-modal vc-modal-surface"
      role="dialog"
      aria-modal="true"
      aria-label="Vorlage einfügen"
    >
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={handleKeydown}
        type="text"
        placeholder="Vorlage suchen..."
        class="vc-tp-input"
        aria-label="Vorlage suchen"
        autocomplete="off"
        spellcheck="false"
      />

      <div class="vc-tp-results" role="listbox" aria-label="Vorlagen">
        {#if templates.length === 0}
          <p class="vc-tp-empty">
            Keine Vorlagen gefunden — lege <code>.md</code>-Dateien in
            <code>.vaultcore/templates/</code> ab.
          </p>
        {:else if filtered.length === 0}
          <p class="vc-tp-empty">Keine Treffer</p>
        {:else}
          {#each filtered as tpl, i (tpl)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="vc-tp-row"
              class:vc-tp-row--selected={i === selectedIndex}
              role="option"
              aria-selected={i === selectedIndex}
              tabindex={-1}
              onclick={() => void selectTemplate(tpl)}
              onmouseenter={() => { selectedIndex = i; }}
            >
              <span class="vc-tp-row-name">{tpl.replace(/\.md$/i, "")}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .vc-tp-backdrop {
    z-index: 200;
  }

  .vc-tp-modal {
    width: 480px;
    max-height: 400px;
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    z-index: 201;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .vc-tp-input {
    width: 100%;
    height: 44px;
    padding: 0 16px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    font-size: 14px;
    outline: none;
    background: var(--color-surface);
    color: var(--color-text);
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .vc-tp-input::placeholder {
    color: var(--color-text-muted);
  }

  .vc-tp-results {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .vc-tp-empty {
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: center;
    padding: 16px;
    margin: 0;
    line-height: 1.6;
  }

  .vc-tp-empty code {
    font-family: var(--vc-font-mono);
    font-size: 11px;
    padding: 1px 4px;
    background: var(--color-surface-alt, rgba(0, 0, 0, 0.06));
    border-radius: 3px;
  }

  .vc-tp-row {
    display: flex;
    align-items: center;
    padding: 6px 16px;
    cursor: pointer;
  }

  .vc-tp-row:hover,
  .vc-tp-row--selected {
    background: var(--color-accent-bg);
  }

  .vc-tp-row-name {
    font-size: 13px;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
