import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textsOf } from "../helpers/text.js";

describe("Graph view", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function graphTabCount(): Promise<number> {
    // tabStore marks graph tabs via label "Graph" — the only non-filename label.
    const labels = await textsOf(await browser.$$(".vc-tab-label"));
    return labels.filter((l) => l === "Graph").length;
  }

  it("opens a Graph tab on Ctrl+Shift+G", async () => {
    await browser.keys(["Control", "Shift", "g"]);

    await browser.waitUntil(async () => (await graphTabCount()) === 1, {
      timeout: 5000,
      timeoutMsg: "Graph tab never appeared",
    });

    const view = await browser.$(".vc-graph-view");
    await view.waitForDisplayed({ timeout: 5000 });
  });

  it("is a singleton — a second Ctrl+Shift+G does not open another Graph tab", async () => {
    await browser.keys(["Control", "Shift", "g"]);
    // Give the handler time to run and tabStore to settle.
    await browser.pause(300);

    const count = await graphTabCount();
    expect(count).toBe(1);
  });

  it("re-focuses the Graph tab when invoked again", async () => {
    // Open a different tab, then fire the shortcut — the Graph tab should become active.
    const treeNode = (await browser.$$(".vc-tree-name"))[0]!;
    await treeNode.click();

    await browser.keys(["Control", "Shift", "g"]);
    await browser.pause(200);

    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 3000 });
    const text = (await activeLabel.getProperty("textContent")) as string;
    expect(text).toBe("Graph");
  });

  it("closes the Graph tab when clicking its close button", async () => {
    // Find the graph tab by label and click its close button.
    await browser.execute(() => {
      const tabs = document.querySelectorAll(".vc-tab");
      for (const tab of Array.from(tabs)) {
        const label = tab.querySelector(".vc-tab-label");
        if (label && (label.textContent ?? "").trim() === "Graph") {
          const closeBtn = tab.querySelector(".vc-tab-close") as HTMLElement | null;
          closeBtn?.click();
          return;
        }
      }
    });

    await browser.waitUntil(async () => (await graphTabCount()) === 0, {
      timeout: 3000,
      timeoutMsg: "Graph tab never closed",
    });
  });

  it("opens the Graph via the sidebar 'Graph öffnen' button", async () => {
    const btn = await browser.$('[aria-label="Graph öffnen"]');
    await btn.waitForDisplayed({ timeout: 3000 });
    await btn.click();

    await browser.waitUntil(async () => (await graphTabCount()) === 1, {
      timeout: 5000,
      timeoutMsg: "Graph tab never appeared after sidebar button click",
    });
  });
});
