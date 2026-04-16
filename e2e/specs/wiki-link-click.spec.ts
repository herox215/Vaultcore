import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Wiki-link click-through", () => {
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

  it("opens the target note when a resolved wiki-link is clicked", async () => {
    // Welcome.md contains `[[Daily Log]]` and `[[Ideas]]` — both resolvable.
    await openTreeFile("Welcome.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // Wait for resolved-link decoration to attach (async getResolvedLinks IPC).
    await browser.waitUntil(
      async () => {
        const links = await browser.$$(".cm-wikilink-resolved");
        return links.length > 0;
      },
      { timeout: 5000, timeoutMsg: ".cm-wikilink-resolved never rendered" },
    );

    // Find the link whose data-wiki-target is "Daily Log" and click it.
    const clicked = await browser.execute(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(".cm-wikilink-resolved"));
      const match = nodes.find((el) => el.getAttribute("data-wiki-target") === "Daily Log");
      if (!match) return false;
      // The wikiLink plugin listens on mousedown — dispatch a real one.
      match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      return true;
    });
    expect(clicked).toBe(true);

    // A new tab titled "Daily Log" should be active shortly after.
    await browser.waitUntil(
      async () => {
        const titles = await textsOf(await browser.$$(".vc-tab-label"));
        return titles.some((t) => t.includes("Daily Log"));
      },
      { timeout: 3000, timeoutMsg: "Daily Log tab never opened" },
    );
  });
});
