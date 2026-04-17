import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * tablePlugin renders GFM pipe-tables as a real <table class="cm-table-rendered">
 * block widget — but only when the cursor is outside the table region. We seed
 * a note with a table and open it; the cursor defaults to pos 0 (before the
 * table), so the widget should mount immediately.
 */
describe("GFM table rendering", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Table Note.md"),
      [
        "# Table Note",
        "",
        "Some intro text.",
        "",
        "| Name  | Age |",
        "| ----- | --- |",
        "| Alice |  30 |",
        "| Bob   |  42 |",
        "",
      ].join("\n"),
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

  it("renders a pipe table as a formatted <table> widget", async () => {
    await openTreeFile("Table Note.md");

    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // Widget mounts as <table class="cm-table-rendered">.
    await browser.waitUntil(
      async () => {
        const found = await browser.execute(() => {
          const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
          const active = panes.find((el) => el.offsetParent !== null);
          const table = active?.querySelector<HTMLTableElement>("table.cm-table-rendered");
          if (!table) return null;
          // Inline-editing scaffolding nests the user-visible text inside a
          // .cm-table-cell span next to the hover controls. Read that span
          // rather than the TH/TD's full textContent (which also includes the
          // control glyphs).
          const headers = Array.from(table.querySelectorAll("th")).map(
            (th) => (th.querySelector(".cm-table-cell")?.textContent ?? "").trim(),
          );
          const firstRow = Array.from(table.querySelectorAll("tbody tr:first-child td"))
            .map((td) => (td.querySelector(".cm-table-cell")?.textContent ?? "").trim());
          return { headers, firstRow };
        });
        if (!found) return false;
        return (
          found.headers.includes("Name") &&
          found.headers.includes("Age") &&
          found.firstRow.includes("Alice")
        );
      },
      { timeout: 5000, timeoutMsg: "Table widget never rendered with expected cells" },
    );
  });
});
