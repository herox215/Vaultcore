import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Tree context menu", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function findTreeNode(name: string): Promise<WebdriverIO.Element> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) return n;
    }
    throw new Error(`"${name}" not in tree`);
  }

  async function openContextMenu(name: string): Promise<void> {
    // `browser.action("pointer")` produces reliable right-click events across
    // WebKit/WebDriver — a plain dispatchEvent(new MouseEvent('contextmenu'))
    // doesn't fire Svelte on:contextmenu listeners in all driver versions.
    const node = await findTreeNode(name);
    await node.scrollIntoView();
    await browser.execute((el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2,
      });
      el.dispatchEvent(ev);
    }, node);

    await browser.$(".vc-context-menu").waitForDisplayed({ timeout: 3000 });
  }

  async function dismissMenu(): Promise<void> {
    // Click the overlay backdrop to close.
    const overlay = await browser.$(".vc-context-overlay");
    if (await overlay.isDisplayed().catch(() => false)) {
      await overlay.click();
    }
    await browser.$(".vc-context-menu").waitForDisplayed({ timeout: 2000, reverse: true });
  }

  it("opens the context menu on right-click of a file row", async () => {
    await openContextMenu("Welcome.md");

    const items = await browser.$$(".vc-context-item");
    const labels = await textsOf(items);
    // At minimum the menu exposes Rename and a trash/delete action.
    expect(labels.some((l) => /rename|umbenennen/i.test(l))).toBe(true);
    expect(labels.some((l) => /trash|papierkorb|löschen|delete/i.test(l))).toBe(true);

    await dismissMenu();
  });

  it("opens the context menu on right-click of a folder row", async () => {
    await openContextMenu("subfolder");

    // Folders should offer at least a "new file here" action.
    const items = await browser.$$(".vc-context-item");
    const labels = await textsOf(items);
    expect(
      labels.some((l) => /neue datei|new file|neue notiz/i.test(l)),
    ).toBe(true);

    await dismissMenu();
  });

  it("dismisses the context menu when the overlay is clicked", async () => {
    await openContextMenu("Welcome.md");
    const overlay = await browser.$(".vc-context-overlay");
    await overlay.click();
    await browser.$(".vc-context-menu").waitForDisplayed({ timeout: 2000, reverse: true });
  });
});
