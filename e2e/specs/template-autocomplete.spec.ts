// E2E regression for #299 — chained template autocomplete caret position.
//
// Drives the full `{{ ` → accept `vault` → type `.` → accept member flow
// through real keyboard selection of popup entries (via Enter) and asserts
// that the final document text and the CodeMirror selection head land where
// the user expects: immediately after the inserted member name.

import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Template autocomplete — caret after chained selection (#299)", () => {
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

  /** Read `view.state.doc.toString()` on the visible editor. */
  async function docText(): Promise<string> {
    return browser.executeAsync((done: (s: string) => void) => {
      void window.__e2e__!.getActiveDocText().then((t) => done(t));
    });
  }

  /** Read `view.state.selection.main.head` on the visible editor. */
  async function selectionHead(): Promise<number> {
    return browser.executeAsync((done: (n: number) => void) => {
      void window.__e2e__!.getActiveSelectionHead().then((n) => done(n));
    });
  }

  /** Read the label of the currently-selected popup option. */
  async function waitForPopupWithOption(label: string): Promise<void> {
    const tooltip = await browser.$(".cm-tooltip-autocomplete");
    await tooltip.waitForDisplayed({ timeout: 3000 });
    await browser.waitUntil(
      async () => {
        const opts = await browser.$$(".cm-tooltip-autocomplete li");
        for (const li of opts) if ((await textOf(li)).startsWith(label)) return true;
        return false;
      },
      { timeout: 3000, timeoutMsg: `popup never surfaced option ${label}` },
    );
  }

  /** Arrow-down until the highlighted option's label starts with `label`, then Enter. */
  async function selectOption(label: string): Promise<void> {
    // The popup auto-highlights the first option. Walk the list until we
    // land on the one we want — keeps the spec independent of insertion
    // order changes in the vault API descriptor.
    for (let i = 0; i < 50; i++) {
      const selectedText = await browser.execute(() => {
        const el = document.querySelector<HTMLElement>(
          ".cm-tooltip-autocomplete li[aria-selected='true']",
        );
        return el?.textContent ?? "";
      });
      if (selectedText.startsWith(label)) {
        await browser.keys(["Enter"]);
        return;
      }
      await browser.keys(["ArrowDown"]);
      await browser.pause(30);
    }
    throw new Error(`could not select option ${label}`);
  }

  it("accepts vault, then `.`, then a member — caret lands at end of member name", async () => {
    await openTreeFile("Welcome.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // Start on a fresh line so we don't collide with existing doc content.
    await typeInEditor("\n{{ ");

    await waitForPopupWithOption("vault");
    await selectOption("vault");
    await browser
      .$(".cm-tooltip-autocomplete")
      .waitForDisplayed({ timeout: 2000, reverse: true });

    // Baseline: after accepting vault, the doc must end with `{{ vault`
    // and the caret must sit at the end of that text.
    await browser.waitUntil(
      async () => {
        const t = await docText();
        return t.endsWith("{{ vault");
      },
      { timeout: 3000, timeoutMsg: "accepting `vault` never produced `{{ vault` at end of doc" },
    );
    const afterVaultDoc = await docText();
    const afterVaultHead = await selectionHead();
    expect(afterVaultHead).toBe(afterVaultDoc.length);

    // Now the regression: `.` then pick a member — caret must end AFTER the
    // member name, not snap back to the `v` of `vault`.
    await typeInEditor(".");
    await waitForPopupWithOption("name");
    await selectOption("name");
    await browser
      .$(".cm-tooltip-autocomplete")
      .waitForDisplayed({ timeout: 2000, reverse: true });

    await browser.waitUntil(
      async () => {
        const t = await docText();
        return t.endsWith("{{ vault.name");
      },
      { timeout: 3000, timeoutMsg: "accepting member never produced `{{ vault.name`" },
    );
    const finalDoc = await docText();
    const finalHead = await selectionHead();
    expect(finalHead).toBe(finalDoc.length);
  });
});
