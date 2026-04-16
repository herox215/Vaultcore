import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

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
      const nodes = await browser.$$(".vc-tree-name");
      for (const node of nodes) {
        if ((await textOf(node)) === "Welcome.md") {
          await node.click();
          break;
        }
      }

      // Wait for CM6's own .cm-content — the outer [data-testid="cm-editor"]
      // wrapper reports zero dimensions to WebKitWebDriver's isDisplayed check
      // until CM finishes mounting.
      const cmContent = await browser.$(".cm-content");
      await cmContent.waitForDisplayed({ timeout: 5000 });

      // Give the app time to settle — the original bug was a race condition
      // between mount and async IPC that produced spurious errors.
      await browser.pause(2000);

      const errorToasts = await browser.$$('[data-testid="toast"][data-variant="error"]');
      expect(errorToasts.length).toBe(0);
    });

    it("opens multiple notes rapidly without errors", async () => {
      const fileNames = ["Daily Log.md", "Ideas.md", "Wiki Links.md"];

      for (const name of fileNames) {
        const nodes = await browser.$$(".vc-tree-name");
        for (const node of nodes) {
          if ((await textOf(node)) === name) {
            await node.click();
            break;
          }
        }
        // Small delay between clicks — enough for the IPC to start
        // but not enough for it to complete (exercises the race).
        await browser.pause(200);
      }

      await browser.pause(2000);

      const errorToasts = await browser.$$('[data-testid="toast"][data-variant="error"]');
      expect(errorToasts.length).toBe(0);
    });
  });
});
