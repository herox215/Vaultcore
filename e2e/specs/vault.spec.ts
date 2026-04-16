import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Vault", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  describe("open", () => {
    it("renders the sidebar with expected files", async () => {
      const sidebar = await browser.$('[data-testid="sidebar"]');
      await expect(sidebar).toBeDisplayed();

      const tree = await browser.$('[role="tree"]');
      await expect(tree).toBeDisplayed();

      const treeNames = await browser.$$(".vc-tree-name");
      const labels = await textsOf(treeNames);
      expect(labels).toContain("Welcome.md");
      expect(labels).toContain("Daily Log.md");
      expect(labels).toContain("Ideas.md");
    });

    it("shows the subfolder in the tree", async () => {
      const treeNames = await browser.$$(".vc-tree-name");
      const labels = await textsOf(treeNames);
      expect(labels).toContain("subfolder");
    });
  });

  describe("note open", () => {
    it("opens a note when clicking in the sidebar", async () => {
      const nodes = await browser.$$(".vc-tree-name");
      let welcomeNode: WebdriverIO.Element | undefined;
      for (const node of nodes) {
        if ((await textOf(node)) === "Welcome.md") {
          welcomeNode = node;
          break;
        }
      }
      expect(welcomeNode).toBeDefined();
      await welcomeNode!.click();

      const activeTab = await browser.$(".vc-tab--active .vc-tab-label");
      await activeTab.waitForDisplayed({ timeout: 5000 });
      expect(await textOf(activeTab)).toBe("Welcome.md");

      // The outer [data-testid="cm-editor"] wrapper has width/height: 100%
      // and reports zero dimensions to WebKitWebDriver's isDisplayed check
      // until CM6 finishes mounting and paints. Wait for .cm-content instead —
      // CM6 creates it as part of its own mount, so its presence is a
      // definitive signal that the editor is usable.
      const cmContent = await browser.$(".cm-content");
      await cmContent.waitForDisplayed({ timeout: 5000 });
    });
  });

  describe("note edit + auto-save", () => {
    it("types text and verifies the dirty indicator appears", async () => {
      const cmContent = await browser.$(".cm-content");
      await cmContent.click();
      await browser.keys(["End"]);
      await browser.keys("\nNew e2e test line");

      const dirty = await browser.$(".vc-tab--active .vc-tab-dirty");
      await dirty.waitForDisplayed({ timeout: 3000 });
    });

    it("auto-saves after a delay", async () => {
      // Wait for auto-save to flush (typically 1-2s debounce).
      await browser.pause(3000);

      const dirty = await browser.$(".vc-tab--active .vc-tab-dirty");
      await dirty.waitForDisplayed({ timeout: 5000, reverse: true });
    });
  });

  describe("tab management", () => {
    it("opens a second tab", async () => {
      const nodes = await browser.$$(".vc-tree-name");
      for (const node of nodes) {
        if ((await textOf(node)) === "Daily Log.md") {
          await node.click();
          break;
        }
      }

      const tabs = await browser.$$(".vc-tab");
      expect(tabs.length).toBeGreaterThanOrEqual(2);

      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      await activeLabel.waitForDisplayed({ timeout: 5000 });
      expect(await textOf(activeLabel)).toBe("Daily Log.md");
    });

    it("switches between tabs", async () => {
      const tabs = await browser.$$(".vc-tab");
      for (const tab of tabs) {
        const label = await tab.$(".vc-tab-label");
        if ((await textOf(label)) === "Welcome.md") {
          await tab.click();
          break;
        }
      }

      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      expect(await textOf(activeLabel)).toBe("Welcome.md");
    });

    it("closes a tab", async () => {
      const tabsBefore = await browser.$$(".vc-tab");
      const countBefore = tabsBefore.length;

      const closeBtn = await browser.$(".vc-tab--active .vc-tab-close");
      await closeBtn.click();

      const tabsAfter = await browser.$$(".vc-tab");
      expect(tabsAfter.length).toBe(countBefore - 1);
    });
  });
});
