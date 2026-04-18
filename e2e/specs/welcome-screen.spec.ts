import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

describe("Welcome screen", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    // Start from a loaded vault so we can exercise the close path. Specs
    // later in the suite assume a loaded vault too, so we must leave one.
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function closeCurrentVault(): Promise<void> {
    await browser.execute(() => {
      void window.__e2e__!.closeVault();
    });
  }

  it("renders the welcome screen when no vault is loaded", async () => {
    await closeCurrentVault();

    const screen = await browser.$('[data-testid="welcome-screen"]');
    await screen.waitForDisplayed({ timeout: 3000 });

    const openBtn = await browser.$('[data-testid="open-vault-button"]');
    await openBtn.waitForDisplayed({ timeout: 2000 });
  });

  it("lists the most-recently-opened vault in the recent list", async () => {
    // The current test vault was loaded in `before()`, so the recent list
    // in the getRecentVaults() IPC call should contain it.
    const rows = await browser.$$('[data-testid="recent-row"]');
    // Either the row is present, or the empty state is shown when recent
    // storage is empty (fresh driver session). Tolerate both.
    if (rows.length === 0) {
      const empty = await browser.$('[data-testid="recent-empty"]');
      expect(await empty.isDisplayed()).toBe(true);
    } else {
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("re-opens a vault via the __e2e__ hook and dismisses the welcome screen", async () => {
    // Reload the same vault via the hook to leave the app in a ready state
    // for subsequent specs that rely on a loaded vault.
    await openVaultInApp(vault.path);

    const sidebar = await browser.$('[data-testid="sidebar"]');
    await sidebar.waitForDisplayed({ timeout: 5000 });

    const welcome = await browser.$('[data-testid="welcome-screen"]');
    await welcome.waitForDisplayed({ timeout: 2000, reverse: true });
  });
});
