/**
 * Open a vault in the running Tauri app by calling the IPC layer directly.
 * This bypasses the native file-picker dialog, which cannot be automated
 * through WebDriver.
 */
export async function openVaultInApp(vaultPath: string): Promise<void> {
  // Invoke the Rust `open_vault` command through the Tauri JS bridge.
  await browser.execute(async (path: string) => {
    const { invoke } = (window as any).__TAURI_INTERNALS__;
    await invoke("open_vault", { path });
  }, vaultPath);

  // Wait for the sidebar to appear — signals that the vault is loaded.
  const sidebar = await browser.$('[data-testid="sidebar"]');
  await sidebar.waitForDisplayed({ timeout: 15_000 });
}
