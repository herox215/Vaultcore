<script lang="ts">
  import { onMount } from "svelte";
  import { vaultStore } from "./store/vaultStore";
  import { toastStore } from "./store/toastStore";
  import {
    getRecentVaults,
    openVault,
    pickVaultFolder,
  } from "./ipc/commands";
  import { isVaultError, vaultErrorCopy, type VaultError } from "./types/errors";
  import type { RecentVault } from "./types/vault";
  import WelcomeScreen from "./components/Welcome/WelcomeScreen.svelte";
  import ToastContainer from "./components/Toast/ToastContainer.svelte";

  let recent: RecentVault[] = $state([]);

  function toVaultError(err: unknown): VaultError {
    if (isVaultError(err)) {
      return { kind: err.kind, message: err.message, data: err.data ?? null };
    }
    return { kind: "Io", message: String(err), data: null };
  }

  async function loadVault(path: string): Promise<void> {
    vaultStore.setOpening(path);
    try {
      const info = await openVault(path);
      // Plan 01-04 will replace the empty fileList with the real file walk
      // results fed by the vault://index_progress event channel.
      vaultStore.setReady({
        currentPath: info.path,
        fileList: [],
        fileCount: info.file_count,
      });
      // Refresh recent-vaults list so the just-opened entry floats to the top
      // next time the Welcome card is shown.
      recent = await getRecentVaults();
    } catch (err) {
      const ve = toVaultError(err);
      const copy = vaultErrorCopy(ve);
      vaultStore.setError(copy);
      toastStore.push({ variant: "error", message: copy });
    }
  }

  async function handlePickVault(): Promise<void> {
    try {
      const picked = await pickVaultFolder();
      if (picked !== null) {
        await loadVault(picked);
      }
    } catch (err) {
      const ve = toVaultError(err);
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function handleOpenRecent(path: string): void {
    void loadVault(path);
  }

  onMount(async () => {
    // VAULT-03: on startup, attempt to reopen the most-recent reachable vault.
    // VAULT-05: if that vault has been moved/deleted/unmounted, we stay on the
    // Welcome screen and surface a toast instead of crashing.
    try {
      recent = await getRecentVaults();
      const last = recent[0];
      if (last !== undefined) {
        await loadVault(last.path);
      }
    } catch (err) {
      const ve = toVaultError(err);
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  });
</script>

{#if $vaultStore.status === "ready"}
  <!-- Placeholder VaultView — plan 01-04 replaces this with the real file
       list + CodeMirror editor from plan 01-03. -->
  <main data-testid="vault-view" class="vc-vault-view">
    <p class="vc-vault-path">Vault opened: {$vaultStore.currentPath}</p>
    <p class="vc-vault-count">{$vaultStore.fileCount} file(s)</p>
  </main>
{:else}
  <WelcomeScreen
    {recent}
    onOpenVault={handleOpenRecent}
    onPickVault={handlePickVault}
  />
{/if}

<ToastContainer />

<style>
  .vc-vault-view {
    padding: 32px;
    color: var(--color-text);
    font-family: var(--vc-font-body);
    font-size: 14px;
  }
  .vc-vault-path {
    margin: 0 0 8px 0;
    font-weight: 700;
  }
  .vc-vault-count {
    margin: 0;
    color: var(--color-text-muted);
  }
</style>
