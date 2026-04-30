<script lang="ts">
  import { ChevronDown, ChevronRight } from "lucide-svelte";
  import { activeViewStore } from "../../store/activeViewStore";
  import { vaultStore } from "../../store/vaultStore";
  import { tabStore } from "../../store/tabStore";
  import { toastStore } from "../../store/toastStore";
  import { treeRefreshStore } from "../../store/treeRefreshStore";
  import { createFile } from "../../ipc/commands";
  import { resolveTarget } from "../Editor/wikiLink";
  import { openFileAsTab } from "../../lib/openFileAsTab";
  import {
    extractOutgoingLinks,
    type OutgoingLink,
  } from "../../lib/outgoingLinks";
  import OutgoingLinkRow from "./OutgoingLinkRow.svelte";

  const STORAGE_KEY_COLLAPSED = "vaultcore-outlinks-collapsed";

  function loadCollapsed(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY_COLLAPSED) === "true";
    } catch {
      return false;
    }
  }

  let collapsed = $state<boolean>(loadCollapsed());

  // Reactive view + doc version — same pattern as PropertiesPanel.
  // Depending on `docVersion` causes the derived list to recompute on every
  // docChanged update of the active editor, which means the panel updates
  // live as the user types wiki-links.
  let view = $derived($activeViewStore.view);
  let version = $derived($activeViewStore.docVersion);

  // `links` reacts to both active-file switches (view identity changes) and
  // in-file edits (docVersion bumps). `resolveTarget` reads the module-level
  // resolution map owned by wikiLink.ts, so newly-created files become
  // resolved as soon as EditorPane refreshes that map.
  let links = $derived.by<OutgoingLink[]>(() => {
    // Touch version so Svelte tracks it even when the view reference is unchanged.
    void version;
    if (!view) return [];
    return extractOutgoingLinks(view.state.doc.toString(), resolveTarget);
  });

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));
    } catch {
      /* ignore */
    }
  }

  function currentVault(): string | null {
    let v: string | null = null;
    const u = vaultStore.subscribe((s) => {
      v = s.currentPath;
    });
    u();
    return v;
  }

  function handleClick(entry: OutgoingLink): void {
    const vault = currentVault();
    if (!vault) return;

    if (entry.resolvedPath !== null) {
      // #388 — route through openFileAsTab so the dispatcher applies the
      // viewport-aware viewMode default (mobile → read, desktop → edit).
      void openFileAsTab(`${vault}/${entry.resolvedPath}`);
      return;
    }

    // Unresolved: create the note at the vault root and open it.
    // Mirrors the click-to-create path in EditorPane.handleWikiLinkClick so
    // behavior matches clicking an unresolved `[[link]]` in the editor.
    const filename = entry.target.endsWith(".md")
      ? entry.target
      : `${entry.target}.md`;
    createFile(vault, filename)
      .then((newAbsPath) => {
        // #388 — NEW notes default to edit on every viewport (matching
        // createNewNote / openTodayNote / Sidebar new-file convention).
        tabStore.openTab(newAbsPath, "edit");
        // Trigger a sidebar tree reload so the newly-created file appears.
        // EditorPane's vaultStore/FILE_CHANGE subscribers will refresh the
        // wiki-link resolution map so the target resolves on subsequent
        // renders.
        treeRefreshStore.requestRefresh();
      })
      .catch(() =>
        toastStore.push({
          variant: "error",
          message: "Notiz konnte nicht erstellt werden.",
        }),
      );
  }

  const resolvedCount = $derived(links.filter((l) => l.resolvedPath !== null).length);
  const unresolvedCount = $derived(links.length - resolvedCount);
</script>

<div class="vc-outlinks-panel" role="complementary" aria-label="Outgoing Links">
  <button
    type="button"
    class="vc-outlinks-header"
    aria-expanded={!collapsed}
    onclick={toggleCollapsed}
  >
    {#if collapsed}
      <ChevronRight size={14} />
    {:else}
      <ChevronDown size={14} />
    {/if}
    <span class="vc-outlinks-label">Outgoing Links</span>
    {#if links.length > 0}
      <span class="vc-outlinks-count">{links.length}</span>
    {/if}
  </button>

  {#if !collapsed}
    <div class="vc-outlinks-body">
      {#if !view}
        <div class="vc-outlinks-empty">Keine Datei geöffnet.</div>
      {:else if links.length === 0}
        <div class="vc-outlinks-empty">
          <div class="vc-outlinks-empty-heading">Keine ausgehenden Links</div>
          <div class="vc-outlinks-empty-body">
            Diese Notiz verweist auf keine andere Datei.
          </div>
        </div>
      {:else}
        <div role="list">
          {#each links as entry (entry.key)}
            <div role="listitem">
              <OutgoingLinkRow {entry} onClick={handleClick} />
            </div>
          {/each}
        </div>
        {#if unresolvedCount > 0}
          <div class="vc-outlinks-footer">
            {resolvedCount} verknüpft · {unresolvedCount} unverknüpft
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .vc-outlinks-panel {
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
  }
  .vc-outlinks-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 16px;
    border: none;
    border-bottom: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    color: var(--color-text-muted);
    width: 100%;
    text-align: left;
  }
  .vc-outlinks-header:hover {
    color: var(--color-accent);
  }
  .vc-outlinks-label {
    font-size: 12px;
    font-weight: 600;
    flex: 1;
  }
  .vc-outlinks-count {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-muted);
  }
  .vc-outlinks-body {
    flex: 0 0 auto;
    max-height: 40vh;
    overflow-y: auto;
  }
  .vc-outlinks-empty {
    padding: 24px 16px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }
  .vc-outlinks-empty-heading {
    font-weight: 600;
    margin-bottom: 6px;
  }
  .vc-outlinks-empty-body {
    font-size: 13px;
    font-weight: 400;
  }
  .vc-outlinks-footer {
    padding: 8px 16px;
    font-size: 12px;
    color: var(--color-text-muted);
    border-top: 1px solid var(--color-border);
  }
</style>
