// Issue #358 — ASCII aesthetic smoke. Three assertions, no spinner
// timing checks (Vitest covers correctness; WDIO covers cross-platform
// rendering smoke).
//
// 1. Welcome screen shows the ASCII wordmark <pre>.
// 2. With a loaded vault, the permanent statusbar accent is mounted and
//    its bounding box does not overlap the encryption pill.
// 3. With an empty editor pane, the ASCII vault-door <pre> is visible.

import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

describe("ASCII aesthetic smoke (#358)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  it("welcome screen renders the ASCII wordmark", async () => {
    // Drop back to the welcome screen.
    await browser.execute(() => {
      void window.__e2e__!.closeVault();
    });

    const screen = await browser.$('[data-testid="welcome-screen"]');
    await screen.waitForDisplayed({ timeout: 3000 });

    const wordmark = await browser.$("pre.vc-welcome-wordmark");
    await wordmark.waitForDisplayed({ timeout: 2000 });
    const text = await wordmark.getText();
    expect(text).toContain("V A U L T C O R E");

    // Re-open the vault for downstream assertions.
    await openVaultInApp(vault.path);
  });

  it("statusbar accent is mounted and does not overlap the encryption pill", async () => {
    const sidebar = await browser.$('[data-testid="sidebar"]');
    await sidebar.waitForDisplayed({ timeout: 5000 });

    const accent = await browser.$(".vc-statusbar-accent");
    await accent.waitForExist({ timeout: 2000 });
    const accentBox = await accent.getLocation();
    const accentSize = await accent.getSize();

    // The encryption pill may not exist if no encrypted folder is in
    // the vault — only run the geometry check when both elements are
    // displayed.
    const pill = await browser.$(".vc-encryption-statusbar");
    if (await pill.isExisting()) {
      const pillBox = await pill.getLocation();
      const pillSize = await pill.getSize();
      const accentBottom = accentBox.y + accentSize.height;
      const pillTop = pillBox.y;
      expect(accentBottom <= pillTop || pillBox.y + pillSize.height <= accentBox.y).toBe(true);
    }
  });

  it("editor empty state renders the ASCII vault door", async () => {
    // No tabs open in a fresh vault → empty state shows.
    const door = await browser.$("pre.vc-editor-empty-door");
    await door.waitForDisplayed({ timeout: 3000 });
    const text = await door.getText();
    expect(text).toContain("┌");
    expect(text).toContain("└");
  });
});
