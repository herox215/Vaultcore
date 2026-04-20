// E2E regression for #301 — custom right-click context menu in the editor
// with a visual template-expression builder.
//
// Flows covered:
//   1. Right-click inside the editor surfaces the VaultCore menu (not the
//      OS default). The menu lists the OS clipboard actions and the custom
//      "Insert template expression…" entry.
//   2. Clicking the custom entry opens a builder dialog; stepping through
//      pickers for `vault.notes.count()` and confirming inserts the final
//      expression at the caret.
//   3. Cancelling the dialog leaves the document unchanged.

import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Editor context menu + template-expression builder (#301)", () => {
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

  async function waitForEditor(): Promise<void> {
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );
  }

  async function rightClickInEditor(): Promise<void> {
    await browser.execute(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
      const active = els.find((el) => el.offsetParent !== null);
      if (!active) throw new Error("no visible editor");
      const rect = active.getBoundingClientRect();
      const x = rect.left + 8;
      const y = rect.top + 8;
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      active.dispatchEvent(ev);
    });
  }

  async function docText(): Promise<string> {
    return browser.executeAsync((done: (s: string) => void) => {
      void window.__e2e__!.getActiveDocText().then((t) => done(t));
    });
  }

  async function clickMenuItem(label: string): Promise<void> {
    const items = await browser.$$(".vc-context-menu .vc-context-item");
    for (const it of items) {
      if ((await textOf(it)).trim() === label) {
        await it.click();
        return;
      }
    }
    throw new Error(`menu item "${label}" not present`);
  }

  /**
   * Click every `<select>` inside the builder in document order with the
   * given labels. Each label matches the visible option text.
   */
  async function buildChain(labels: string[]): Promise<void> {
    for (const label of labels) {
      // The latest unlocked step is the last select — select by option label.
      await browser.waitUntil(
        async () => {
          const selects = await browser.$$(
            ".vc-template-builder select.vc-template-builder-step",
          );
          if (selects.length === 0) return false;
          const last = selects[selects.length - 1]!;
          const opts = await last.$$("option");
          for (const o of opts) {
            if ((await textOf(o)).trim() === label) return true;
          }
          return false;
        },
        { timeout: 2000, timeoutMsg: `step with option "${label}" never appeared` },
      );
      const selects = await browser.$$(
        ".vc-template-builder select.vc-template-builder-step",
      );
      const last = selects[selects.length - 1]!;
      await last.selectByVisibleText(label);
    }
  }

  it("right-click surfaces the VaultCore menu with clipboard + template entries", async () => {
    await openTreeFile("Welcome.md");
    await waitForEditor();
    await rightClickInEditor();

    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 2000 });

    const items = await browser.$$(".vc-context-menu .vc-context-item");
    const labels: string[] = [];
    for (const it of items) labels.push((await textOf(it)).trim());

    expect(labels).toContain("Insert template expression…");
    expect(labels).toContain("Cut");
    expect(labels).toContain("Copy");
    expect(labels).toContain("Paste");
    expect(labels).toContain("Select All");
    // Ticket: custom entry at the top.
    expect(labels[0]).toBe("Insert template expression…");

    // Close via Escape so the next test starts clean.
    await browser.keys(["Escape"]);
    await menu.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("builder inserts `{{ vault.notes.count() }}` at the caret on confirm", async () => {
    await openTreeFile("Welcome.md");
    await waitForEditor();
    const before = await docText();
    await rightClickInEditor();
    await clickMenuItem("Insert template expression…");

    const dialog = await browser.$(".vc-template-builder");
    await dialog.waitForDisplayed({ timeout: 2000 });

    // Step through the pickers: notes → count.
    await buildChain(["notes", "count()"]);

    // Confirm.
    const insertBtn = await browser.$(".vc-template-builder-insert");
    await insertBtn.click();
    await dialog.waitForDisplayed({ timeout: 2000, reverse: true });

    await browser.waitUntil(
      async () => (await docText()).includes("{{ vault.notes.count() }}"),
      { timeout: 3000, timeoutMsg: "inserted expression never surfaced in doc" },
    );
    const after = await docText();
    expect(after).toContain("{{ vault.notes.count() }}");
    expect(after).not.toBe(before);
  });

  it("cancelling the builder leaves the document unchanged", async () => {
    await openTreeFile("Welcome.md");
    await waitForEditor();
    const before = await docText();
    await rightClickInEditor();
    await clickMenuItem("Insert template expression…");

    const dialog = await browser.$(".vc-template-builder");
    await dialog.waitForDisplayed({ timeout: 2000 });

    await buildChain(["notes"]); // interact so the live preview updates
    const cancelBtn = await browser.$(".vc-template-builder-cancel");
    await cancelBtn.click();
    await dialog.waitForDisplayed({ timeout: 2000, reverse: true });

    const after = await docText();
    expect(after).toBe(before);
  });
});
