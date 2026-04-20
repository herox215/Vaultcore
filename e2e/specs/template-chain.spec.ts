// E2E coverage for #303 — `;`-chained template expressions.
//
// Types a multi-segment `{{ ... ; ... }}` body into a real editor, waits
// for the live-preview widget to replace the source text, and asserts the
// rendered text is the concatenation of the per-segment values.

import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Template chains — `;`-separated multi-segment expressions (#303)", () => {
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

  async function typeInEditor(text: string): Promise<void> {
    await browser.executeAsync((t: string, done: () => void) => {
      window.__e2e__!.typeInActiveEditor(t).then(() => done());
    }, text);
  }

  async function docText(): Promise<string> {
    return browser.executeAsync((done: (s: string) => void) => {
      void window.__e2e__!.getActiveDocText().then((t) => done(t));
    });
  }

  it("renders `{{ vault.name; \" - \"; vault.notes.count() }}` as the concatenation", async () => {
    await openTreeFile("Welcome.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // Fresh line so we don't collide with existing content.
    await typeInEditor('\n{{ vault.name; " - "; vault.notes.count() }}');

    // Move cursor off the expression so the live-preview widget replaces
    // the source text. Easiest: append a trailing newline.
    await typeInEditor("\nend");

    // Wait until the doc contains the full typed body and the widget
    // decoration has rendered.
    await browser.waitUntil(
      async () => {
        const t = await docText();
        return t.includes('{{ vault.name; " - "; vault.notes.count() }}');
      },
      { timeout: 3000, timeoutMsg: "multi-segment body never landed in doc" },
    );

    // The widget text starts with the vault name, contains the literal
    // separator, and ends with a number — the exact count depends on the
    // seeded test vault, so we assert shape rather than a specific number.
    await browser.waitUntil(
      async () => {
        const text = await browser.execute(() => {
          const el = document.querySelector<HTMLElement>(".vc-template-rendered");
          return el?.textContent ?? "";
        });
        return /^.+ - \d+$/.test(text) && text.length > " - 0".length;
      },
      { timeout: 4000, timeoutMsg: "rendered widget never matched concatenation shape" },
    );
  });
});
