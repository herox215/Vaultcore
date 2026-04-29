<script lang="ts">
  import type { RecentVault } from "../../types/vault";
  import RecentVaultRow from "./RecentVaultRow.svelte";

  let {
    recent = [],
    onOpenVault,
    onPickVault,
  }: {
    recent?: RecentVault[];
    onOpenVault: (path: string) => void;
    onPickVault: () => void;
  } = $props();
</script>

<main class="vc-welcome" data-testid="welcome-screen">
  <div class="vc-welcome-card">
    <h1 class="vc-welcome-heading">VaultCore</h1>
    <p class="vc-welcome-tagline">A faster Markdown workspace for large vaults.</p>

    <button
      type="button"
      class="vc-cta"
      data-testid="open-vault-button"
      onclick={onPickVault}
    >
      Open vault
    </button>

    <hr class="vc-divider" />

    <h2 class="vc-recent-label">RECENT VAULTS</h2>

    {#if recent.length === 0}
      <div class="vc-empty" data-testid="recent-empty">
        <p class="vc-empty-heading">No recent vaults</p>
        <p class="vc-empty-body">Open a folder to get started.</p>
      </div>
    {:else}
      <div class="vc-recent-list" data-testid="recent-list">
        {#each recent as vault (vault.path)}
          <RecentVaultRow {vault} onOpen={onOpenVault} />
        {/each}
      </div>
    {/if}
  </div>
</main>

<style>
  .vc-welcome {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 64px 16px;
    background: var(--color-bg);
    font-family: var(--vc-font-body);
  }
  .vc-welcome-card {
    width: 100%;
    max-width: 480px;
    padding: 48px 32px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }
  .vc-welcome-heading {
    margin: 0 0 8px 0;
    font-size: 20px;
    font-weight: 700;
    line-height: 1.2;
    color: var(--color-text);
  }
  .vc-welcome-tagline {
    margin: 0 0 32px 0;
    font-size: 14px;
    font-weight: 400;
    line-height: 1.5;
    color: var(--color-text-muted);
  }
  .vc-cta {
    display: block;
    width: 100%;
    padding: 8px 16px;
    background: var(--color-accent);
    color: #ffffff;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 400;
    font-family: var(--vc-font-body);
    cursor: pointer;
  }
  .vc-cta:hover {
    filter: brightness(0.9);
  }
  .vc-cta:active {
    filter: brightness(0.8);
  }
  .vc-cta:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .vc-divider {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 24px 0;
  }
  .vc-recent-label {
    margin: 0 0 8px 0;
    font-size: 12px;
    font-weight: 400;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  .vc-empty {
    padding: 8px 16px;
    color: var(--color-text-muted);
  }
  .vc-empty-heading {
    margin: 0 0 4px 0;
    font-size: 14px;
    color: var(--color-text);
  }
  .vc-empty-body {
    margin: 0;
    font-size: 14px;
  }
  .vc-recent-list {
    display: flex;
    flex-direction: column;
  }
</style>
