import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

describe("Error handling", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  describe("#90 regression — no spurious error toast on note open", () => {
    it("opens a note without triggering an error toast", async () => {
      // Open a note
      const nodes = await browser.$$(".vc-tree-name");
      for (const node of nodes) {
        if ((await node.getText()) === "Welcome.md") {
          await node.click();
          break;
        }
      }

      // Wait for the editor to render
      const editor = await browser.$('[data-testid="cm-editor"]');
      await editor.waitForDisplayed({ timeout: 5000 });

      // Give the app time to settle — the original bug was a race condition
      // between mount and async IPC that produced spurious errors.
      await browser.pause(2000);

      // There should be no error toasts
      const errorToasts = await browser.$$('[data-testid="toast"][data-variant="error"]');
      expect(errorToasts.length).toBe(0);
    });

    it("opens multiple notes rapidly without errors", async () => {
      const fileNames = ["Daily Log.md", "Ideas.md", "Wiki Links.md"];

      for (const name of fileNames) {
        const nodes = await browser.$$(".vc-tree-name");
        for (const node of nodes) {
          if ((await node.getText()) === name) {
            await node.click();
            break;
          }
        }
        // Small delay between clicks — enough for the IPC to start
        // but not enough for it to complete (exercises the race).
        await browser.pause(200);
      }

      // Let everything settle
      await browser.pause(2000);

      // Still no error toasts
      const errorToasts = await browser.$$('[data-testid="toast"][data-variant="error"]');
      expect(errorToasts.length).toBe(0);
    });
  });
});
