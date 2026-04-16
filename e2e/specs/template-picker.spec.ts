import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Template picker", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();

    // Seed two template files so the picker has a deterministic list.
    const templatesDir = path.join(vault.path, ".vaultcore", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, "Meeting.md"),
      "## Meeting — {{title}}\n\n- Attendees:\n- Agenda:\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(templatesDir, "Idea.md"),
      "## Idea\n\nStatus: draft\n",
      "utf-8",
    );

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

  it("opens the picker on Ctrl+Shift+T and lists templates", async () => {
    await openTreeFile("Welcome.md");
    await browser.$(".cm-content").waitForDisplayed({ timeout: 5000 });

    await browser.keys(["Control", "Shift", "t"]);

    const modal = await browser.$(".vc-tp-modal");
    await modal.waitForDisplayed({ timeout: 3000 });

    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tp-row-name"));
        return names.some((n) => n.includes("Meeting")) && names.some((n) => n.includes("Idea"));
      },
      { timeout: 3000, timeoutMsg: "Expected templates never appeared in the picker" },
    );

    await browser.keys(["Escape"]);
    await modal.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("filters templates by the search query", async () => {
    await browser.keys(["Control", "Shift", "t"]);
    const modal = await browser.$(".vc-tp-modal");
    await modal.waitForDisplayed({ timeout: 3000 });

    const input = await browser.$(".vc-tp-input");
    await input.setValue("Meet");
    await browser.pause(100);

    const rows = await browser.$$(".vc-tp-row-name");
    const names = await textsOf(rows);
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining("Meeting")]));
    expect(names.some((n) => n.includes("Idea"))).toBe(false);

    await browser.keys(["Escape"]);
    await modal.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("inserts the template content into the active editor on Enter", async () => {
    await openTreeFile("Welcome.md");
    await browser.$(".cm-content").waitForDisplayed({ timeout: 5000 });

    await browser.keys(["Control", "Shift", "t"]);
    await browser.$(".vc-tp-modal").waitForDisplayed({ timeout: 3000 });
    const input = await browser.$(".vc-tp-input");
    await input.setValue("Idea");
    await browser.pause(100);
    await browser.keys(["Enter"]);

    await browser.$(".vc-tp-modal").waitForDisplayed({ timeout: 2000, reverse: true });

    // The Idea template has the literal string "Status: draft"; verify it
    // landed in the document.
    await browser.waitUntil(
      async () => {
        const txt = await browser.execute(() => {
          const el = document.querySelector(".cm-content");
          return el?.textContent ?? "";
        });
        return txt.includes("Status: draft");
      },
      { timeout: 3000, timeoutMsg: "Template content was not inserted into the editor" },
    );
  });
});
