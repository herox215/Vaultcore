import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Tag autocomplete", () => {
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

  /**
   * `#<prefix>` triggers `tagCompletionSource`. The fixture seeds tags
   * `#ideas`, `#brainstorm`, `#journal`, `#daily`, `#subfolder` so typing
   * `#i` should produce at least one match.
   */
  async function typeInEditor(text: string): Promise<void> {
    await browser.executeAsync((t: string, done: () => void) => {
      window.__e2e__!.typeInActiveEditor(t).then(() => done());
    }, text);
  }

  it("opens the tag completion popup when # is typed at a word boundary", async () => {
    await openTreeFile("Welcome.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // Newline → guarantees we're at a word boundary, not mid-word.
    await typeInEditor("\n#i");

    const tooltip = await browser.$(".cm-tooltip-autocomplete");
    await tooltip.waitForDisplayed({ timeout: 3000 });

    const options = await browser.$$(".cm-tooltip-autocomplete li");
    expect(options.length).toBeGreaterThan(0);

    await browser.keys(["Escape"]);
    await browser.$(".cm-tooltip-autocomplete").waitForDisplayed({ timeout: 2000, reverse: true });
  });
});
