<script lang="ts">
  /**
   * Breadcrumb bar shown between the tab bar and editor content.
   *
   * Renders the folder path of the active tab's file, relative to the vault
   * root, as clickable segments separated by "›". Folder segments call
   * treeRevealStore.requestReveal() so the sidebar expands and scrolls to them.
   * The filename segment is styled distinctly but is a no-op on click.
   *
   * Long paths are truncated from the left with an ellipsis using the
   * direction:rtl + direction:ltr trick so the filename stays visible.
   *
   * Hidden when no tab is open in the pane.
   */
  import { vaultStore } from "../../store/vaultStore";
  import { treeRevealStore } from "../../store/treeRevealStore";

  interface Props {
    /** Absolute file path of the tab whose breadcrumbs to show, or null. */
    filePath: string | null;
  }

  let { filePath }: Props = $props();

  interface Segment {
    label: string;
    /** Vault-relative path up to and including this segment (folders only). */
    relPath: string | null; // null for the filename segment (no-op on click)
    isFile: boolean;
  }

  /**
   * Split an absolute file path into breadcrumb segments, keyed to the active
   * vault root. Returns an empty list when the file lives outside the vault
   * (should not happen in practice, but we never want to render a misleading
   * bar).
   */
  function computeSegments(abs: string | null, vault: string | null): Segment[] {
    if (!abs || !vault) return [];
    const normalisedVault = vault.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalisedAbs = abs.replace(/\\/g, "/");
    if (!normalisedAbs.startsWith(normalisedVault + "/")) return [];

    const rel = normalisedAbs.slice(normalisedVault.length + 1);
    if (!rel) return [];

    const parts = rel.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) return [];

    const segments: Segment[] = [];
    const runningPath: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part === undefined) continue;
      const isFile = i === parts.length - 1;
      runningPath.push(part);
      segments.push({
        label: part,
        relPath: isFile ? null : runningPath.join("/"),
        isFile,
      });
    }
    return segments;
  }

  const segments = $derived(computeSegments(filePath, $vaultStore.currentPath));

  function handleFolderClick(relPath: string) {
    treeRevealStore.requestReveal(relPath);
  }
</script>

{#if segments.length > 0}
  <nav class="vc-breadcrumbs" aria-label="File path">
    <div class="vc-breadcrumbs-inner">
      {#each segments as seg, i (i)}
        {#if i > 0}
          <span class="vc-breadcrumbs-sep" aria-hidden="true">&#8250;</span>
        {/if}
        {#if seg.isFile}
          <!-- Filename segment: distinct styling, no-op click (AC-05). -->
          <span class="vc-breadcrumbs-segment vc-breadcrumbs-segment--file">
            {seg.label}
          </span>
        {:else}
          <button
            type="button"
            class="vc-breadcrumbs-segment vc-breadcrumbs-segment--folder"
            onclick={() => handleFolderClick(seg.relPath as string)}
            title="Reveal {seg.label} in the file tree"
          >
            {seg.label}
          </button>
        {/if}
      {/each}
    </div>
  </nav>
{/if}

<style>
  /* Outer bar — fills the pane width, applies the rtl trick so that when the
     inner line overflows the ellipsis shows up on the LEFT while the filename
     stays glued to the right edge (AC-04). */
  .vc-breadcrumbs {
    display: flex;
    align-items: center;
    height: 28px;
    padding: 0 12px;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    overflow: hidden;
    direction: rtl;
  }

  .vc-breadcrumbs-inner {
    direction: ltr;
    display: inline-block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    font-size: 12px;
    color: var(--color-text-muted);
    line-height: 1;
  }

  .vc-breadcrumbs-sep {
    margin: 0 4px;
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  .vc-breadcrumbs-segment {
    background: none;
    border: none;
    padding: 2px 2px;
    font: inherit;
    color: inherit;
    cursor: default;
    border-radius: 3px;
  }

  .vc-breadcrumbs-segment--folder {
    cursor: pointer;
  }

  .vc-breadcrumbs-segment--folder:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent);
  }

  .vc-breadcrumbs-segment--folder:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  /* Filename segment — distinct style per AC-07 (bolder + normal text color). */
  .vc-breadcrumbs-segment--file {
    color: var(--color-text);
    font-weight: 600;
  }
</style>
