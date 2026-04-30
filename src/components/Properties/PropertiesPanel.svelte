<script lang="ts">
  import { tick } from "svelte";
  import { Plus, X } from "lucide-svelte";
  import { activeViewStore } from "../../store/activeViewStore";
  import {
    parseFrontmatter,
    computeFrontmatterEdit,
    type Property,
  } from "../../lib/frontmatterIO";

  // `version` is a direct dependency of `parsed` so edits to the doc via
  // anywhere (this panel included) re-derive the property list.
  let view = $derived($activeViewStore.view);
  let version = $derived($activeViewStore.docVersion);

  let parsed = $derived.by(() => {
    // touch version so $derived tracks it even if view is unchanged
    void version;
    if (!view) return { properties: [] as Property[] };
    return parseFrontmatter(view.state.doc.toString());
  });

  function commit(next: Property[]): void {
    if (!view) return;
    const edit = computeFrontmatterEdit(view.state.doc.toString(), next);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
    });
  }

  function updateRow(index: number, patch: Partial<Property>): void {
    const next = parsed.properties.map((p, i) => (i === index ? { ...p, ...patch } : p));
    commit(next);
  }

  function deleteRow(index: number): void {
    const next = parsed.properties.filter((_, i) => i !== index);
    commit(next);
  }

  function addRow(): void {
    const existing = parsed.properties;
    let base = "property";
    let candidate = base;
    let n = 1;
    const keys = new Set(existing.map((p) => p.key));
    while (keys.has(candidate)) {
      n += 1;
      candidate = `${base}${n}`;
    }
    commit([...existing, { key: candidate, values: [""], listStyle: false }]);
  }

  async function promoteToList(index: number): Promise<void> {
    const row = parsed.properties[index];
    if (!row) return;
    if (!row.listStyle) {
      const cleaned = row.values.length === 1 && row.values[0] === "" ? [] : row.values;
      updateRow(index, { listStyle: true, values: cleaned });
    }
    await tick();
    focusChipInput(index);
  }

  function focusChipInput(index: number): void {
    const input = document.querySelector<HTMLInputElement>(
      `[data-chip-input="${index}"]`,
    );
    input?.focus();
  }

  function appendChipValue(index: number, raw: string): void {
    if (raw === "") return;
    const row = parsed.properties[index];
    if (!row) return;
    const nextValues = [...row.values, raw];
    const next = parsed.properties.map((p, i) =>
      i === index ? { ...p, values: nextValues, listStyle: true } : p,
    );
    commit(next);
  }

  function removeChipAt(rowIndex: number, valueIndex: number): void {
    const row = parsed.properties[rowIndex];
    if (!row) return;
    const nextValues = row.values.filter((_, i) => i !== valueIndex);
    updateRow(rowIndex, { values: nextValues });
  }

  function onChipInputKeydown(e: KeyboardEvent, index: number): void {
    if (e.key === "Enter") {
      e.preventDefault();
      const el = e.currentTarget as HTMLInputElement;
      appendChipValue(index, el.value);
      el.value = "";
    }
  }

  function onChipInputBlur(e: FocusEvent, index: number): void {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value !== "") {
      appendChipValue(index, el.value);
      el.value = "";
    }
  }
</script>

<div class="vc-props-panel" role="complementary" aria-label="Properties">
  <div class="vc-props-header">
    <span class="vc-props-label">Properties</span>
    <button
      type="button"
      class="vc-props-add"
      onclick={addRow}
      disabled={!view}
      aria-label="Eigenschaft hinzufügen"
      title="Eigenschaft hinzufügen"
    >
      <Plus size={14} />
    </button>
  </div>

  <div class="vc-props-body">
    {#if !view}
      <div class="vc-props-empty">Keine Datei geöffnet.</div>
    {:else if parsed.properties.length === 0}
      <div class="vc-props-empty">
        Keine Eigenschaften. Klicke <span class="vc-props-inline-plus">+</span>, um eine hinzuzufügen.
      </div>
    {:else}
      <div class="vc-props-list">
        {#each parsed.properties as prop, index (index)}
          <div class="vc-props-row">
            <input
              type="text"
              class="vc-props-key"
              value={prop.key}
              onchange={(e) => updateRow(index, { key: e.currentTarget.value })}
              aria-label="Schlüssel"
              spellcheck="false"
            />
            <div class="vc-props-value-col">
              {#if prop.listStyle}
                <div class="vc-props-chips" data-list-row={index}>
                  {#each prop.values as chip, ci (ci)}
                    <span class="vc-props-chip">
                      <span class="vc-props-chip-text">{chip}</span>
                      <button
                        type="button"
                        class="vc-props-chip-del"
                        onclick={() => removeChipAt(index, ci)}
                        aria-label="Wert entfernen"
                        title="Wert entfernen"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  {/each}
                  <input
                    type="text"
                    class="vc-props-chip-input"
                    data-chip-input={index}
                    placeholder={prop.values.length === 0 ? "Wert hinzufügen" : ""}
                    onkeydown={(e) => onChipInputKeydown(e, index)}
                    onblur={(e) => onChipInputBlur(e, index)}
                    aria-label="Wert hinzufügen"
                    spellcheck="false"
                  />
                </div>
              {:else}
                <input
                  type="text"
                  class="vc-props-value"
                  value={prop.values[0] ?? ""}
                  onchange={(e) => updateRow(index, { values: [e.currentTarget.value] })}
                  aria-label="Wert"
                  spellcheck="false"
                />
              {/if}
            </div>
            <button
              type="button"
              class="vc-props-plus"
              onclick={() => promoteToList(index)}
              aria-label="Wert hinzufügen"
              title="Wert hinzufügen"
            >
              <Plus size={12} />
            </button>
            <button
              type="button"
              class="vc-props-del"
              onclick={() => deleteRow(index)}
              aria-label="Eigenschaft löschen"
              title="Löschen"
            >
              <X size={12} />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .vc-props-panel {
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
  }
  .vc-props-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--color-border);
  }
  .vc-props-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: none;
  }
  .vc-props-add {
    width: 24px;
    height: 24px;
    /* #385 — fallbacks equal width/height (byte-identical); coarse → 44×44. */
    min-width: var(--vc-hit-target, 24px);
    min-height: var(--vc-hit-target, 24px);
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    border-radius: 4px;
  }
  .vc-props-add:hover:not(:disabled) { background: var(--color-accent-bg); color: var(--color-accent); }
  .vc-props-add:disabled { opacity: 0.4; cursor: not-allowed; }
  .vc-props-body {
    padding: 12px 16px;
  }
  .vc-props-empty {
    font-size: 13px;
    color: var(--color-text-muted);
    padding: 4px 0 8px 0;
  }
  .vc-props-inline-plus {
    font-family: var(--vc-font-mono);
    font-size: 12px;
    padding: 0 4px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
  }
  .vc-props-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .vc-props-row {
    display: grid;
    grid-template-columns: 32% 1fr 20px 20px;
    gap: 4px;
    align-items: start;
  }
  .vc-props-key,
  .vc-props-value {
    height: 24px;
    /* #385 — fallback 24 equals `height` (byte-identical); coarse → 44px. */
    min-height: var(--vc-hit-target, 24px);
    font-size: 13px;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 0 6px;
    box-sizing: border-box;
    outline: none;
    min-width: 0;
    width: 100%;
  }
  .vc-props-key { font-family: var(--vc-font-mono); color: var(--color-text-muted); }
  .vc-props-key:focus,
  .vc-props-value:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-accent-bg);
  }
  .vc-props-value-col {
    min-width: 0;
  }
  .vc-props-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    /* #385 — fallback 24 preserves the existing min-height; coarse → 44px. */
    min-height: var(--vc-hit-target, 24px);
    padding: 2px 4px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    box-sizing: border-box;
  }
  .vc-props-chips:focus-within {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-accent-bg);
  }
  .vc-props-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px 0 6px;
    height: 18px;
    font-size: 11px;
    line-height: 18px;
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-radius: 10px;
    max-width: 100%;
  }
  .vc-props-chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc-props-chip-del {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0;
    border-radius: 50%;
  }
  .vc-props-chip-del:hover { color: var(--color-error); }
  .vc-props-chip-input {
    flex: 1;
    min-width: 40px;
    border: none;
    outline: none;
    background: transparent;
    font-size: 13px;
    color: var(--color-text);
    padding: 0 2px;
    height: 18px;
  }
  .vc-props-plus,
  .vc-props-del {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    border-radius: 3px;
    margin-top: 2px;
  }
  .vc-props-plus:hover { background: var(--color-accent-bg); color: var(--color-accent); }
  .vc-props-del:hover { background: var(--color-accent-bg); color: var(--color-error); }
</style>
