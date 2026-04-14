<script lang="ts">
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
    commit([...existing, { key: candidate, value: "" }]);
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
            <input
              type="text"
              class="vc-props-value"
              value={prop.value}
              onchange={(e) => updateRow(index, { value: e.currentTarget.value })}
              aria-label="Wert"
              spellcheck="false"
            />
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
    grid-template-columns: 32% 1fr 20px;
    gap: 4px;
    align-items: center;
  }
  .vc-props-key,
  .vc-props-value {
    height: 24px;
    font-size: 13px;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 0 6px;
    box-sizing: border-box;
    outline: none;
    min-width: 0;
  }
  .vc-props-key { font-family: var(--vc-font-mono); color: var(--color-text-muted); }
  .vc-props-key:focus,
  .vc-props-value:focus {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-accent-bg);
  }
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
  }
  .vc-props-del:hover { background: var(--color-accent-bg); color: var(--color-error); }
</style>
