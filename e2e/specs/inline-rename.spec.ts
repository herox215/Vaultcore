import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Inline rename", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  /**
   * Right-click isn't reliable across WebKitWebDriver — dispatch the
   * `contextmenu` MouseEvent straight at the row. Behaviourally identical
   * to a real right-click for TreeNode's handler.
   */
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

  /**
   * Click the menu item by label via DOM dispatch — WebKitWebDriver
   * sometimes reports clicks on .vc-context-item as intercepted by the
   * underlying overlay despite z-index. Dispatch skips the pointer layer.
   */
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

  /**
   * Set the rename input's value and dispatch `input` so Svelte's
   * handleInput keeps state in sync. WDIO v9's setValue on a Svelte
   * {value}-bound input (no bind:value) throws stale-element on WebKit —
   * this bypasses the driver's elementClear + elementSendKeys sequence.
   */
  async function setRenameValue(value: string): Promise<void> {
    await browser.execute((v: string) => {
      const el = document.querySelector(".vc-rename-input") as HTMLInputElement | null;
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  }

  async function startRename(name: string): Promise<WebdriverIO.Element> {
    await openContextMenuFor(name);

    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });

    await clickMenuItem("Rename");

    const input = await browser.$(".vc-rename-input");
    await input.waitForDisplayed({ timeout: 3000 });
    return input;
  }

  it("opens the inline rename input from the context menu", async () => {
    const input = await startRename("Ideas.md");
    const value = (await input.getProperty("value")) as string;
    expect(value).toBe("Ideas.md");

    await browser.keys(["Escape"]);
    await input.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("renames the file when typing a new name and pressing Enter", async () => {
    const input = await startRename("Ideas.md");

    await setRenameValue("Renamed Ideas.md");
    await browser.keys(["Enter"]);

    await input.waitForDisplayed({ timeout: 5000, reverse: true });

    // Every fixture file has inbound wiki-links, so renameFile succeeds but
    // TreeNode opens the "update N links?" confirmation modal. Clicking
    // Abbrechen leaves the tree stale (onRefreshParent never fires), so
    // accept with Aktualisieren — that refreshes the tree synchronously
    // before the async backlink rewrite starts.
    const acceptBtn = await browser.$(".vc-confirm-btn--accent");
    if (await acceptBtn.isDisplayed().catch(() => false)) {
      await acceptBtn.click();
      await acceptBtn.waitForDisplayed({ timeout: 3000, reverse: true });
    }

    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes("Renamed Ideas.md") && !names.includes("Ideas.md");
      },
      { timeout: 5000, timeoutMsg: "Rename never reflected in the tree" },
    );
  });

  it("discards the edit when Escape is pressed", async () => {
    const input = await startRename("Daily Log.md");

    await setRenameValue("Should Not Persist.md");
    await browser.keys(["Escape"]);

    await input.waitForDisplayed({ timeout: 2000, reverse: true });

    const names = await textsOf(await browser.$$(".vc-tree-name"));
    expect(names).toContain("Daily Log.md");
    expect(names).not.toContain("Should Not Persist.md");
  });

  it("shows a validation error when the name contains a slash", async () => {
    const input = await startRename("Welcome.md");

    await setRenameValue("foo/bar.md");
    await browser.keys(["Enter"]);

    const err = await browser.$(".vc-rename-error");
    await err.waitForDisplayed({ timeout: 2000 });
    expect(await textOf(err)).toContain("/");

    expect(await input.isDisplayed()).toBe(true);

    await browser.keys(["Escape"]);
    await input.waitForDisplayed({ timeout: 2000, reverse: true });

    const names = await textsOf(await browser.$$(".vc-tree-name"));
    expect(names).toContain("Welcome.md");
  });

  it("keeps the filename unchanged when confirming with the same name", async () => {
    const input = await startRename("Welcome.md");

    await browser.keys(["Enter"]);

    await input.waitForDisplayed({ timeout: 3000, reverse: true });

    const names = await textsOf(await browser.$$(".vc-tree-name"));
    expect(names).toContain("Welcome.md");
  });
});
