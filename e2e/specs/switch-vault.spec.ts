import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Vault switching", () => {
  let vaultA: TestVault;
  let vaultB: TestVault;

  // Marker file that only exists in the second vault — its presence in the
  // tree after switching proves the sidebar rerendered against the new
  // fileList rather than re-using the stale first-vault state.
  const MARKER_FILE = "Only In Vault B.md";

  before(async () => {
    vaultA = createTestVault();
    vaultB = createTestVault();
    fs.writeFileSync(
      path.join(vaultB.path, MARKER_FILE),
      "# Only in vault B\n\nThis file proves the switch happened.\n",
      "utf-8",
    );
    await openVaultInApp(vaultA.path);
  });

  after(() => {
    vaultA.cleanup();
    vaultB.cleanup();
  });

  it("opens the settings modal via the topbar button", async () => {
    const settingsBtn = await browser.$('[aria-label="Einstellungen"]');
    await settingsBtn.waitForDisplayed({ timeout: 3000 });
    await settingsBtn.click();

    const modal = await browser.$('[data-testid="settings-modal"]');
    await modal.waitForDisplayed({ timeout: 3000 });

    const switchBtn = await browser.$('[data-testid="settings-switch-vault"]');
    await switchBtn.waitForDisplayed({ timeout: 2000 });
    expect(await textOf(switchBtn)).toContain("Vault wechseln");

    // Close the modal so subsequent specs aren't stuck with an overlay.
    await browser.keys(["Escape"]);
    await modal.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("switches to a different vault via the __e2e__ hook", async () => {
    // Sanity: marker file from vault B is NOT in the current tree.
    const before = await textsOf(await browser.$$(".vc-tree-name"));
    expect(before).not.toContain(MARKER_FILE);

    await browser.executeAsync((targetPath: string, done: () => void) => {
      void window.__e2e__!.switchVault(targetPath).then(() => done());
    }, vaultB.path);

    // Wait for the marker file to appear — reliably proves the new fileList
    // reached the sidebar.
    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes(MARKER_FILE);
      },
      { timeout: 10_000, timeoutMsg: `"${MARKER_FILE}" never appeared in the tree` },
    );

    const after = await textsOf(await browser.$$(".vc-tree-name"));
    expect(after).toContain(MARKER_FILE);
    // Vault B also has the shared fixtures, so Welcome.md is still there.
    expect(after).toContain("Welcome.md");
  });

  it("closes all tabs from the previous vault on switch", async () => {
    // No tabs should be open after the switch — handleSwitchVault /
    // __e2e__.switchVault closes them before loading the new vault.
    const tabs = await browser.$$(".vc-tab");
    expect(tabs.length).toBe(0);
  });
});
