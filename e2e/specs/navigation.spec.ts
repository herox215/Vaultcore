import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

describe("Navigation", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  describe("wiki-link click", () => {
    it("navigates to the linked note when clicking a wiki-link", async () => {
      // Open Welcome.md which contains [[Daily Log]] and [[Ideas]]
      const nodes = await browser.$$(".vc-tree-name");
      for (const node of nodes) {
        if ((await node.getText()) === "Welcome.md") {
          await node.click();
          break;
        }
      }

      // Wait for the editor to load
      const editor = await browser.$('[data-testid="cm-editor"]');
      await editor.waitForDisplayed({ timeout: 5000 });

      // Find a resolved wiki-link and click it
      const wikiLink = await browser.$(".cm-wikilink-resolved");
      await wikiLink.waitForDisplayed({ timeout: 5000 });
      await wikiLink.click();

      // A new tab should open for the target note
      await browser.pause(500);
      const tabs = await browser.$$(".vc-tab");
      expect(tabs.length).toBeGreaterThanOrEqual(2);

      // The active tab should be the target note (not Welcome.md)
      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      const targetName = await activeLabel.getText();
      expect(["Daily Log.md", "Ideas.md"]).toContain(targetName);
    });
  });

  describe("quick switcher", () => {
    it("opens and searches for a file", async () => {
      // Open quick switcher with Ctrl+O on Linux (the hotkey dispatch
      // in src/lib/commands/registry.ts treats metaKey || ctrlKey as "meta",
      // and the default binding is { meta: true, key: "o" }).
      await browser.keys(["Control", "o"]);

      // The quick switcher modal should appear
      const input = await browser.$(".vc-qs-input");
      await input.waitForDisplayed({ timeout: 3000 });

      // Type a search query
      await input.setValue("Ideas");

      // Wait for results
      await browser.pause(500);
      const results = await browser.$$(".vc-qs-row");
      expect(results.length).toBeGreaterThanOrEqual(1);

      // The first result should contain "Ideas"
      const firstName = await results[0]!.$(".vc-qs-row-filename");
      expect(await firstName.getText()).toContain("Ideas");

      // Select the result
      await browser.keys(["Enter"]);

      // The quick switcher should close
      await input.waitForDisplayed({ timeout: 3000, reverse: true });

      // Ideas.md should be the active tab
      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      await activeLabel.waitForDisplayed({ timeout: 3000 });
      expect(await activeLabel.getText()).toBe("Ideas.md");
    });
  });
});
