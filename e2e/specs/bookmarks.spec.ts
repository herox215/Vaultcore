import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Bookmarks", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openFileInSidebar(name: string): Promise<void> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const node of nodes) {
      if ((await textOf(node)) === name) {
        await node.click();
        return;
      }
    }
    throw new Error(`Tree node "${name}" not found`);
  }

  async function waitForActiveTab(name: string): Promise<void> {
    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 5000 });
    await browser.waitUntil(async () => (await textOf(activeLabel)) === name, {
      timeout: 3000,
      timeoutMsg: `Active tab never became ${name}`,
    });
  }

  it("shows the empty state before any bookmark is added", async () => {
    const empty = await browser.$(".vc-bookmarks-empty");
    await empty.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(empty)).toContain("Keine Lesezeichen");
  });

  it("is a no-op when no tab is active", async () => {
    // Ensure no active tab exists — fresh vault has none until we click one.
    const activeTabs = await browser.$$(".vc-tab--active");
    expect(activeTabs.length).toBe(0);

    await browser.keys(["Control", "d"]);
    await browser.pause(200);

    const rows = await browser.$$(".vc-bookmark-row");
    expect(rows.length).toBe(0);
  });

  it("adds the active note as a bookmark on Ctrl+D", async () => {
    await openFileInSidebar("Welcome.md");
    await waitForActiveTab("Welcome.md");

    await browser.keys(["Control", "d"]);

    const row = await browser.$(".vc-bookmark-row");
    await row.waitForDisplayed({ timeout: 3000 });

    const name = await row.$(".vc-bookmark-name");
    expect(await textOf(name)).toBe("Welcome.md");
  });

  it("removes the bookmark when Ctrl+D is pressed again", async () => {
    // Precondition from prior test: Welcome.md is bookmarked and active.
    const rowsBefore = await browser.$$(".vc-bookmark-row");
    expect(rowsBefore.length).toBe(1);

    await browser.keys(["Control", "d"]);
    await browser.pause(300);

    const rowsAfter = await browser.$$(".vc-bookmark-row");
    expect(rowsAfter.length).toBe(0);

    const empty = await browser.$(".vc-bookmarks-empty");
    await empty.waitForDisplayed({ timeout: 3000 });
  });

  it("bookmarks additional notes without replacing existing ones", async () => {
    await openFileInSidebar("Welcome.md");
    await waitForActiveTab("Welcome.md");
    await browser.keys(["Control", "d"]);
    await browser.waitUntil(async () => (await browser.$$(".vc-bookmark-row")).length === 1, {
      timeout: 3000,
      timeoutMsg: "first bookmark never appeared",
    });

    await openFileInSidebar("Ideas.md");
    await waitForActiveTab("Ideas.md");
    await browser.keys(["Control", "d"]);
    await browser.waitUntil(async () => (await browser.$$(".vc-bookmark-row")).length === 2, {
      timeout: 3000,
      timeoutMsg: "second bookmark never appeared",
    });

    const rows = await browser.$$(".vc-bookmark-row");
    const names: string[] = [];
    for (const row of rows) {
      const nameEl = await row.$(".vc-bookmark-name");
      names.push(await textOf(nameEl));
    }
    expect(names).toContain("Welcome.md");
    expect(names).toContain("Ideas.md");
  });
});
