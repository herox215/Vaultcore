import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

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

      const wikiLink = await browser.$(".cm-wikilink-resolved");
      await wikiLink.waitForDisplayed({ timeout: 5000 });
      await wikiLink.click();

      await browser.pause(500);
      const tabs = await browser.$$(".vc-tab");
      expect(tabs.length).toBeGreaterThanOrEqual(2);

      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      const targetName = await textOf(activeLabel);
      expect(["Daily Log.md", "Ideas.md"]).toContain(targetName);
    });
  });

  describe("quick switcher", () => {
    it("opens and searches for a file", async () => {
      // Open quick switcher with Ctrl+O on Linux (the hotkey dispatch
      // in src/lib/commands/registry.ts treats metaKey || ctrlKey as "meta",
      // and the default binding is { meta: true, key: "o" }).
      await browser.keys(["Control", "o"]);

      const input = await browser.$(".vc-qs-input");
      await input.waitForDisplayed({ timeout: 3000 });

      await input.setValue("Ideas");

      await browser.pause(500);
      const results = await browser.$$(".vc-qs-row");
      expect(results.length).toBeGreaterThanOrEqual(1);

      const firstName = await results[0]!.$(".vc-qs-row-filename");
      expect(await textOf(firstName)).toContain("Ideas");

      await browser.keys(["Enter"]);

      await input.waitForDisplayed({ timeout: 3000, reverse: true });

      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      await activeLabel.waitForDisplayed({ timeout: 3000 });
      expect(await textOf(activeLabel)).toBe("Ideas.md");
    });
  });
});
