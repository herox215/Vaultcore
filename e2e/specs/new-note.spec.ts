import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textsOf } from "../helpers/text.js";

describe("Create file / folder", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function waitForTreeName(expected: string, timeout = 4000): Promise<void> {
    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes(expected);
      },
      { timeout, timeoutMsg: `"${expected}" never appeared in the tree` },
    );
  }

  it("creates 'Unbenannte Notiz.md' on Ctrl+N and opens it as a tab", async () => {
    await browser.keys(["Control", "n"]);

    await waitForTreeName("Unbenannte Notiz.md");

    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 3000 });
    await browser.waitUntil(
      async () => (await activeLabel.getProperty("textContent")) === "Unbenannte Notiz.md",
      { timeout: 3000, timeoutMsg: "New note never became the active tab" },
    );
  });

  it("auto-suffixes on a second Ctrl+N press", async () => {
    // Precondition from the prior test: "Unbenannte Notiz.md" already exists.
    await browser.keys(["Control", "n"]);
    await waitForTreeName("Unbenannte Notiz 1.md");

    // And a third time — ensures the suffix counter advances, not sits at 1.
    await browser.keys(["Control", "n"]);
    await waitForTreeName("Unbenannte Notiz 2.md");
  });

  it("creates 'Untitled.md' via the sidebar + note button (primary click)", async () => {
    // #145 renamed the header button from "New file" to "New note" and
    // introduced a chevron dropdown alongside it. The primary click path
    // (this test) must still create a note in one click — no extra UI.
    const btn = await browser.$('[aria-label="New note"]');
    await btn.waitForDisplayed({ timeout: 3000 });
    await btn.click();

    await waitForTreeName("Untitled.md");
  });

  it("auto-suffixes the sidebar + note button on repeat clicks", async () => {
    const btn = await browser.$('[aria-label="New note"]');
    await btn.click();
    await waitForTreeName("Untitled 1.md");

    await btn.click();
    await waitForTreeName("Untitled 2.md");
  });

  it("exposes canvas creation from the header dropdown (#145)", async () => {
    // Open the split-button chevron and pick "New canvas" — the canvas
    // affordance used to be reachable only via right-click.
    const chevron = await browser.$('[data-testid="sidebar-new-menu-toggle"]');
    await chevron.waitForDisplayed({ timeout: 3000 });
    await chevron.click();

    const canvasItem = await browser.$('[data-testid="sidebar-new-menu-canvas"]');
    await canvasItem.waitForDisplayed({ timeout: 3000 });
    await canvasItem.click();

    await waitForTreeName("Untitled.canvas");

    // File opens in the canvas viewer, not the markdown editor — assert the
    // viewer mounted so we know the tab used the canvas viewer branch.
    await browser.$(".vc-canvas-viewport").waitForDisplayed({ timeout: 3000 });
  });

  it("creates 'New Folder' via the sidebar + folder button", async () => {
    const btn = await browser.$('[aria-label="New folder"]');
    await btn.waitForDisplayed({ timeout: 3000 });
    await btn.click();

    await waitForTreeName("New Folder");
  });

  it("auto-suffixes the folder button on repeat clicks", async () => {
    const btn = await browser.$('[aria-label="New folder"]');
    await btn.click();
    await waitForTreeName("New Folder 1");
  });
});
