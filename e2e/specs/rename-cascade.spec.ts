import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * Welcome.md is referenced by [[Welcome]] in Daily Log.md, Ideas.md and
 * Wiki Links.md (3 backlinks). Renaming it must open the D-09 cascade
 * confirmation dialog and, on confirm, rewrite those links via
 * `update_links_after_rename`.
 *
 * Right-click + menu-item click both go through browser.execute — the
 * WebKitWebDriver reports pointer clicks on .vc-context-item as intercepted
 * by the overlay (same pattern as inline-rename.spec.ts).
 */
describe("Rename cascade dialog", () => {
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
    await browser.$(".vc-context-menu").waitForDisplayed({ timeout: 3000 });
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

  async function setRenameValue(value: string): Promise<void> {
    await browser.execute((v: string) => {
      const el = document.querySelector(".vc-rename-input") as HTMLInputElement | null;
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  }

  it("shows the cascade dialog when renaming a note that has backlinks", async () => {
    await openContextMenuFor("Welcome.md");
    await clickMenuItem("Rename");

    const input = await browser.$(".vc-rename-input");
    await input.waitForDisplayed({ timeout: 3000 });

    await setRenameValue("Welcome Renamed.md");
    await browser.keys(["Enter"]);

    // Rename-input unmounts, cascade dialog appears. After the #378 lift the
    // dialog lives on the Sidebar (single owner, survives the watcher
    // re-flatten that destroys the per-row TreeRow). The aria-labelledby is
    // now a stable string; the prefix selector still matches.
    await input.waitForDisplayed({ timeout: 5000, reverse: true });
    const dialog = await browser.$('[aria-labelledby^="rename-heading"]');
    await dialog.waitForDisplayed({ timeout: 3000 });

    const body = await browser.$(".vc-confirm-body");
    const bodyText = await textOf(body);
    // "<N> Links in <M> Dateien werden aktualisiert. Fortfahren?"
    expect(/\d+\s+Links?\s+in\s+\d+\s+Dateien/.test(bodyText)).toBe(true);
  });

  it("applies the cascade when the confirm button is clicked", async () => {
    const confirmBtn = await browser.$(".vc-confirm-btn--accent");
    await confirmBtn.click();

    await browser.$('[aria-labelledby^="rename-heading"]').waitForDisplayed({
      timeout: 3000, reverse: true,
    });

    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes("Welcome Renamed.md") && !names.includes("Welcome.md");
      },
      { timeout: 5000, timeoutMsg: "Rename never reflected in the tree" },
    );
  });
});
