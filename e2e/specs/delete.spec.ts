import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Delete file", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openContextMenuFor(name: string): Promise<void> {
    await browser.execute((target: string) => {
      const nodes = document.querySelectorAll(".vc-tree-name");
      for (const n of Array.from(nodes)) {
        if ((n.textContent ?? "").trim() === target) {
          const row = (n as Element).closest(".vc-tree-row");
          if (!row) return;
          row.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: 100,
          }));
          return;
        }
      }
    }, name);
  }

  async function clickMenuItem(label: string): Promise<void> {
    await browser.execute((target: string) => {
      const items = document.querySelectorAll(".vc-context-item");
      for (const el of Array.from(items)) {
        if ((el.textContent ?? "").trim() === target) {
          (el as HTMLElement).click();
          return;
        }
      }
    }, label);
  }

  async function openSidebarNote(name: string): Promise<void> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`"${name}" not in tree`);
  }

  it("keeps the file when the delete confirm is dismissed with 'Keep File'", async () => {
    await openContextMenuFor("Wiki Links.md");
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });
    await clickMenuItem("Move to Trash");

    const cancelBtn = await browser.$(".vc-confirm-btn--cancel");
    await cancelBtn.waitForDisplayed({ timeout: 3000 });
    await cancelBtn.click();
    await cancelBtn.waitForDisplayed({ timeout: 2000, reverse: true });

    const names = await textsOf(await browser.$$(".vc-tree-name"));
    expect(names).toContain("Wiki Links.md");
  });

  it("moves the file to trash and removes it from the tree on confirm", async () => {
    await openContextMenuFor("Wiki Links.md");
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });
    await clickMenuItem("Move to Trash");

    const confirmBtn = await browser.$(".vc-confirm-btn--danger");
    await confirmBtn.waitForDisplayed({ timeout: 3000 });
    await confirmBtn.click();
    await confirmBtn.waitForDisplayed({ timeout: 2000, reverse: true });

    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return !names.includes("Wiki Links.md");
      },
      { timeout: 5000, timeoutMsg: "File still in tree after Move to Trash" },
    );
  });

  // BUG #102: app-initiated deletes are filtered from the FS watcher by
  // write_ignore, so the frontend never receives kind:"delete" and
  // Sidebar.svelte:112 never calls tabStore.closeByPath(). Skip until the
  // Rust side emits a dedicated delete notification (or stops recording
  // the source path in write_ignore).
  it.skip("closes the open tab when its backing file is deleted", async () => {
    await openSidebarNote("Ideas.md");
    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(activeLabel)).toBe("Ideas.md");

    await openContextMenuFor("Ideas.md");
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });
    await clickMenuItem("Move to Trash");

    const confirmBtn = await browser.$(".vc-confirm-btn--danger");
    await confirmBtn.waitForDisplayed({ timeout: 3000 });
    await confirmBtn.click();

    await browser.waitUntil(
      async () => {
        const labels = await textsOf(await browser.$$(".vc-tab-label"));
        return !labels.includes("Ideas.md");
      },
      { timeout: 5000, timeoutMsg: "Ideas.md tab never closed after delete" },
    );
  });
});
