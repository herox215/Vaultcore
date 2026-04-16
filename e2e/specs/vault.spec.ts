import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

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

      // The test vault has top-level files: Welcome.md, Daily Log.md, Ideas.md, Wiki Links.md
      const treeNames = await browser.$$(".vc-tree-name");
      const labels = await Promise.all(treeNames.map((el) => el.getText()));
      expect(labels).toContain("Welcome.md");
      expect(labels).toContain("Daily Log.md");
      expect(labels).toContain("Ideas.md");
    });

    it("shows the subfolder in the tree", async () => {
      const treeNames = await browser.$$(".vc-tree-name");
      const labels = await Promise.all(treeNames.map((el) => el.getText()));
      expect(labels).toContain("subfolder");
    });
  });

  describe("note open", () => {
    it("opens a note when clicking in the sidebar", async () => {
      // Click on "Welcome.md" in the tree
      const nodes = await browser.$$(".vc-tree-name");
      let welcomeNode: WebdriverIO.Element | undefined;
      for (const node of nodes) {
        if ((await node.getText()) === "Welcome.md") {
          welcomeNode = node;
          break;
        }
      }
      expect(welcomeNode).toBeDefined();
      await welcomeNode!.click();

      // A tab should appear
      const activeTab = await browser.$(".vc-tab--active .vc-tab-label");
      await activeTab.waitForDisplayed({ timeout: 5000 });
      expect(await activeTab.getText()).toBe("Welcome.md");

      // The editor should show content
      const editor = await browser.$('[data-testid="cm-editor"]');
      await editor.waitForDisplayed({ timeout: 5000 });
    });
  });

  describe("note edit + auto-save", () => {
    it("types text and verifies the dirty indicator appears", async () => {
      // Focus the editor and type
      const cmContent = await browser.$(".cm-content");
      await cmContent.click();
      await browser.keys(["End"]);
      await browser.keys("\nNew e2e test line");

      // The dirty indicator should appear on the active tab
      const dirty = await browser.$(".vc-tab--active .vc-tab-dirty");
      await dirty.waitForDisplayed({ timeout: 3000 });
    });

    it("auto-saves after a delay", async () => {
      // Wait for auto-save to flush (typically 1-2s debounce)
      await browser.pause(3000);

      // The dirty indicator should disappear once saved
      const dirty = await browser.$(".vc-tab--active .vc-tab-dirty");
      await dirty.waitForDisplayed({ timeout: 5000, reverse: true });
    });
  });

  describe("tab management", () => {
    it("opens a second tab", async () => {
      // Click on "Daily Log.md"
      const nodes = await browser.$$(".vc-tree-name");
      for (const node of nodes) {
        if ((await node.getText()) === "Daily Log.md") {
          await node.click();
          break;
        }
      }

      const tabs = await browser.$$(".vc-tab");
      expect(tabs.length).toBeGreaterThanOrEqual(2);

      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      await activeLabel.waitForDisplayed({ timeout: 5000 });
      expect(await activeLabel.getText()).toBe("Daily Log.md");
    });

    it("switches between tabs", async () => {
      // Click the Welcome.md tab to switch back
      const tabs = await browser.$$(".vc-tab");
      for (const tab of tabs) {
        const label = await tab.$(".vc-tab-label");
        if ((await label.getText()) === "Welcome.md") {
          await tab.click();
          break;
        }
      }

      const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
      expect(await activeLabel.getText()).toBe("Welcome.md");
    });

    it("closes a tab", async () => {
      const tabsBefore = await browser.$$(".vc-tab");
      const countBefore = tabsBefore.length;

      // Close the active tab (Welcome.md)
      const closeBtn = await browser.$(".vc-tab--active .vc-tab-close");
      await closeBtn.click();

      const tabsAfter = await browser.$$(".vc-tab");
      expect(tabsAfter.length).toBe(countBefore - 1);
    });
  });
});
