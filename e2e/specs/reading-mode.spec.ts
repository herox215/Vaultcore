import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Reading mode", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openTreeFile(name: string): Promise<void> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`"${name}" not in tree`);
  }

  it("toggles between edit mode and reading view on Ctrl+E", async () => {
    await openTreeFile("Welcome.md");
    const cm = await browser.$(".cm-content");
    await cm.waitForDisplayed({ timeout: 5000 });

    // Fire shortcut — editor should be replaced by reading view.
    await browser.keys(["Control", "e"]);

    const reading = await browser.$(".vc-reading-view");
    await reading.waitForDisplayed({ timeout: 3000 });

    const content = await browser.$(".vc-reading-content");
    await browser.waitUntil(
      async () => (await textOf(content)).includes("Welcome to the test vault"),
      { timeout: 3000, timeoutMsg: "Rendered reading content never contained expected heading" },
    );

    // Toggle back — CodeMirror reappears.
    await browser.keys(["Control", "e"]);
    await reading.waitForDisplayed({ timeout: 3000, reverse: true });
    await cm.waitForDisplayed({ timeout: 3000 });
  });

  it("renders markdown headings as <h1> in the reading view", async () => {
    await openTreeFile("Welcome.md");
    await browser.$(".cm-content").waitForDisplayed({ timeout: 5000 });

    await browser.keys(["Control", "e"]);
    await browser.$(".vc-reading-view").waitForDisplayed({ timeout: 3000 });

    const h1 = await browser.$(".vc-reading-content h1");
    await h1.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(h1)).toContain("Welcome");

    // Reset to edit mode.
    await browser.keys(["Control", "e"]);
    await browser.$(".cm-content").waitForDisplayed({ timeout: 3000 });
  });
});
