/**
 * Open a vault in the running Tauri app by calling the frontend's loadVault
 * directly through the window.__e2e__ hook exposed in src/App.svelte when
 * VITE_E2E=1. Calling the Rust open_vault command via invoke() alone is not
 * enough — it updates backend state but never triggers vaultStore.setReady,
 * so the sidebar never renders. The hook routes through the same frontend
 * path as a regular vault open, making the UI actually transition.
 */
export async function openVaultInApp(vaultPath: string): Promise<void> {
  // Wait until the hook is installed (App.svelte onMount runs after the
  // webview finishes booting).
  await browser.waitUntil(
    async () =>
      browser.execute(() => typeof window.__e2e__ === "object"),
    { timeout: 10_000, timeoutMsg: "window.__e2e__ hook never appeared — was the app built with VITE_E2E=1?" },
  );

  await browser.executeAsync((path: string, done: () => void) => {
    void window.__e2e__!.loadVault(path).then(() => done());
  }, vaultPath);

  // Sidebar becomes visible once vaultStore.status === "ready".
  const sidebar = await browser.$('[data-testid="sidebar"]');
  await sidebar.waitForDisplayed({ timeout: 15_000 });

  // The sidebar container appears immediately; the file tree is rendered
  // asynchronously from vaultStore.fileList on the next Svelte tick. Specs
  // that query .vc-tree-name right after openVaultInApp() race that render
  // and see an empty list, so wait for at least one tree entry.
  const firstNode = await browser.$(".vc-tree-name");
  await firstNode.waitForDisplayed({ timeout: 10_000 });
}
