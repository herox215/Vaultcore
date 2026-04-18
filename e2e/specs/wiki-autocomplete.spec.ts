import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Wiki-link autocomplete", () => {
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
   * CM6 lives inside a contenteditable; WebKit driver keystrokes don't reach
   * it reliably. The `typeInActiveEditor` __e2e__ hook dispatches real CM6
   * transactions with `userEvent: "input.type"` — CM6's autocomplete plugin
   * listens for those and triggers the CompletionSource.
   */
  async function typeInEditor(text: string): Promise<void> {
    await browser.executeAsync((t: string, done: () => void) => {
      window.__e2e__!.typeInActiveEditor(t).then(() => done());
    }, text);
  }

  it("opens the completion popup when [[ is typed", async () => {
    await openTreeFile("Welcome.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // Put the caret at doc end on a fresh line, then trigger [[.
    await typeInEditor("\n[[");

    const tooltip = await browser.$(".cm-tooltip-autocomplete");
    await tooltip.waitForDisplayed({ timeout: 3000 });

    const options = await browser.$$(".cm-tooltip-autocomplete li");
    expect(options.length).toBeGreaterThan(0);

    await browser.keys(["Escape"]);
    await browser.$(".cm-tooltip-autocomplete").waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("inserts a wiki-link when a completion option is selected", async () => {
    await typeInEditor("\n[[");
    await browser.$(".cm-tooltip-autocomplete").waitForDisplayed({ timeout: 3000 });

    // Narrow the list, then accept the first match.
    await typeInEditor("Daily");
    await browser.pause(150);
    await browser.keys(["Enter"]);

    await browser.$(".cm-tooltip-autocomplete").waitForDisplayed({ timeout: 2000, reverse: true });

    await browser.waitUntil(
      async () => {
        const txt = await browser.execute(() => {
          const els = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
          const active = els.find((el) => el.offsetParent !== null);
          return active?.textContent ?? "";
        });
        return txt.includes("Daily Log");
      },
      { timeout: 3000, timeoutMsg: "Completion never inserted a 'Daily Log' link into the document" },
    );
  });
});
