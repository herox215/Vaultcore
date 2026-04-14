<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { themeStore } from "./store/themeStore";
  import { settingsStore } from "./store/settingsStore";
  import { vaultStore } from "./store/vaultStore";
  import { tabStore } from "./store/tabStore";
  import { toastStore } from "./store/toastStore";
  import { progressStore } from "./store/progressStore";
  import {
    getRecentVaults,
    openVault,
    pickVaultFolder,
  } from "./ipc/commands";
  import { listenIndexProgress } from "./ipc/events";
  import { isVaultError, vaultErrorCopy } from "./types/errors";
  import type { RecentVault } from "./types/vault";
  import WelcomeScreen from "./components/Welcome/WelcomeScreen.svelte";
  import VaultLayout from "./components/Layout/VaultLayout.svelte";
  import ToastContainer from "./components/Toast/ToastContainer.svelte";
  import ProgressBar from "./components/Progress/ProgressBar.svelte";

  let recent: RecentVault[] = $state([]);
  let unlistenProgress: (() => void) | null = null;

  function toVaultError(err: unknown) {
    if (isVaultError(err)) {
      return { kind: err.kind, message: err.message, data: err.data ?? null };
    }
    return { kind: "Io" as const, message: String(err), data: null };
  }

  async function loadVault(path: string): Promise<void> {
    vaultStore.setOpening(path);
    progressStore.start(0);
    try {
      const info = await openVault(path);
      vaultStore.setReady({
        currentPath: info.path,
        fileList: info.file_list,
        fileCount: info.file_count,
      });
      progressStore.finish();
      // Refresh recent-vaults list so the just-opened entry floats to the top
      // next time the Welcome card is shown.
      recent = await getRecentVaults();
    } catch (err) {
      progressStore.finish();
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

  async function handleSwitchVault(): Promise<void> {
    try {
      const picked = await pickVaultFolder();
      if (picked === null) return;
      let currentPath: string | null = null;
      const unsub = vaultStore.subscribe((s) => { currentPath = s.currentPath; });
      unsub();
      if (currentPath === picked) return;
      tabStore.closeAll();
      await loadVault(picked);
    } catch (err) {
      const ve = toVaultError(err);
      toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
    }
  }

  function handleOpenRecent(path: string): void {
    void loadVault(path);
  }

  onMount(async () => {
    themeStore.init();
    settingsStore.init();

    // Subscribe to progress events before any vault open happens
    unlistenProgress = await listenIndexProgress((payload) => {
      progressStore.update(payload.current, payload.total, payload.current_file);
    });

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

  onDestroy(() => {
    unlistenProgress?.();
  });
</script>

{#if $vaultStore.status === "ready"}
  <VaultLayout onSwitchVault={handleSwitchVault} />
{:else}
  <WelcomeScreen
    {recent}
    onOpenVault={handleOpenRecent}
    onPickVault={handlePickVault}
  />
{/if}

<ProgressBar />
<ToastContainer />
