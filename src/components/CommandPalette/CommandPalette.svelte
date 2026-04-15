<script lang="ts">
  import { tick } from "svelte";
  import { commandRegistry, type Command } from "../../lib/commands/registry";
  import { formatShortcut } from "../../lib/shortcuts";
  import { fuzzyMatch } from "../../lib/commands/fuzzy";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>();
  let commands = $state<Command[]>([]);

  const unsub = commandRegistry.subscribe((list) => { commands = list; });

  interface Row {
    cmd: Command;
    matchIndices: number[];
  }

  const rows = $derived.by<Row[]>(() => {
    const q = query.trim();
    if (!q) {
      const mru = commandRegistry.getMru();
      const byId = new Map(commands.map((c) => [c.id, c]));
      const mruRows: Row[] = [];
      const seen = new Set<string>();
      for (const id of mru) {
        const c = byId.get(id);
        if (!c) continue;
        mruRows.push({ cmd: c, matchIndices: [] });
        seen.add(id);
      }
      const rest: Row[] = commands
        .filter((c) => !seen.has(c.id))
        .map((c) => ({ cmd: c, matchIndices: [] }));
      return [...mruRows, ...rest];
    }
    const scored: Array<Row & { score: number }> = [];
    for (const cmd of commands) {
      const m = fuzzyMatch(cmd.name, q);
      if (!m) continue;
      scored.push({ cmd, matchIndices: m.matchIndices, score: m.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ cmd, matchIndices }) => ({ cmd, matchIndices }));
  });

  $effect(() => {
    if (open) {
      query = "";
      selectedIndex = 0;
      void tick().then(() => inputEl?.focus());
    }
  });

  $effect(() => {
    // Clamp selected index when rows shrink below it.
    if (selectedIndex >= rows.length) selectedIndex = 0;
  });

  function handleInput(): void {
    selectedIndex = 0;
  }

  async function runCommand(cmd: Command): Promise<void> {
    onClose();
    await tick();
    commandRegistry.execute(cmd.id);
  }

  function handleKeydown(e: KeyboardEvent): void {
    const count = rows.length;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
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
      const row = rows[selectedIndex];
      if (row) void runCommand(row.cmd);
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose();
  }

  function highlight(name: string, indices: number[]): Array<{ text: string; hit: boolean }> {
    if (indices.length === 0) return [{ text: name, hit: false }];
    const out: Array<{ text: string; hit: boolean }> = [];
    let last = 0;
    for (const i of indices) {
      if (i > last) out.push({ text: name.slice(last, i), hit: false });
      out.push({ text: name.slice(i, i + 1), hit: true });
      last = i + 1;
    }
    if (last < name.length) out.push({ text: name.slice(last), hit: false });
    return out;
  }

  import { onDestroy } from "svelte";
  onDestroy(() => unsub());
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-command-palette-backdrop"
    onclick={handleBackdropClick}
    data-testid="command-palette-backdrop"
  >
    <div
      class="vc-command-palette-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Befehlspalette"
    >
      <input
        bind:this={inputEl}
        bind:value={query}
        oninput={handleInput}
        onkeydown={handleKeydown}
        type="text"
        placeholder="Befehl suchen…"
        class="vc-cp-input"
        aria-label="Befehl suchen"
        autocomplete="off"
        spellcheck="false"
        data-testid="command-palette-input"
      />

      <div class="vc-cp-results" role="listbox" aria-label="Befehle">
        {#if rows.length === 0}
          <p class="vc-cp-empty">Keine passenden Befehle</p>
        {:else}
          {#each rows as row, i (row.cmd.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <button
              type="button"
              class="vc-cp-row"
              class:vc-cp-row--selected={i === selectedIndex}
              role="option"
              aria-selected={i === selectedIndex}
              onclick={() => runCommand(row.cmd)}
              onmouseenter={() => { selectedIndex = i; }}
              data-testid="command-palette-row"
              data-command-id={row.cmd.id}
            >
              <span class="vc-cp-row-name">
                {#each highlight(row.cmd.name, row.matchIndices) as part}
                  {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
              {#if row.cmd.hotkey}
                <span class="vc-cp-row-hotkey">
                  <kbd>{formatShortcut(row.cmd.hotkey)}</kbd>
                </span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .vc-command-palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 200;
  }
  .vc-command-palette-modal {
    width: 560px;
    max-height: 480px;
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    z-index: 201;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .vc-cp-input {
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
  .vc-cp-input::placeholder { color: var(--color-text-muted); }
  .vc-cp-results { overflow-y: auto; flex: 1; min-height: 0; }
  .vc-cp-empty {
    font-size: 12px;
    color: var(--color-text-muted);
    text-align: center;
    padding: 16px;
    margin: 0;
  }
  .vc-cp-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text);
    font-size: 14px;
    text-align: left;
  }
  .vc-cp-row--selected { background: var(--color-accent-bg); color: var(--color-accent); }
  .vc-cp-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vc-cp-row-name mark { background: transparent; color: var(--color-accent); font-weight: 600; }
  .vc-cp-row-hotkey kbd {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 6px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text-muted);
    font-family: var(--vc-font-mono);
  }
</style>
