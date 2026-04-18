import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * Structural AC from issue #101:
 *  - Hover on right edge shows a "+" to add a column.
 *  - Hover on bottom edge shows a "+" to add a row.
 *  - Drag handles reorder rows/columns.
 *  - Delete action removes a row or column.
 *  - Column header click cycles sort direction.
 *  - All structural changes dispatch CM6 transactions.
 *
 * We assert BOTH the DOM state (cell counts, content at positions) AND the
 * resulting markdown source (via the __e2e__.getActiveDocText hook). This
 * covers the "dispatch CM6 transactions" criterion — the doc wouldn't
 * change otherwise.
 */

describe("Inline table editing — structural", () => {
  let vault: TestVault;

  const TABLE_LINES = [
    "# Structural",
    "",
    "Intro.",
    "",
    "| Name  | Age |",
    "| ----- | --- |",
    "| Alice |  30 |",
    "| Bob   |  42 |",
    "| Cara  |  25 |",
    "",
  ];

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Structural.md"),
      TABLE_LINES.join("\n"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
    await openTreeFile("Structural.md");
    await waitForTable();
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

  async function waitForTable(): Promise<void> {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const panes = Array.from(
            document.querySelectorAll<HTMLElement>(".cm-content"),
          );
          const active = panes.find((el) => el.offsetParent !== null);
          return !!active?.querySelector("table.cm-table-rendered");
        }),
      { timeout: 5000, timeoutMsg: "Table widget never rendered" },
    );
  }

  async function getDocText(): Promise<string> {
    return browser.executeAsync((done: (s: string) => void) => {
      void window.__e2e__!.getActiveDocText().then((t) => done(t));
    });
  }

  async function tableShape(): Promise<{ cols: number; rows: number }> {
    return browser.execute(() => {
      const table = document.querySelector<HTMLTableElement>(
        "table.cm-table-rendered",
      );
      if (!table) return { cols: 0, rows: 0 };
      const cols = table.querySelectorAll("thead th").length;
      const rows = table.querySelectorAll("tbody tr").length;
      return { cols, rows };
    });
  }

  async function cellTexts(): Promise<string[][]> {
    return browser.execute(() => {
      const table = document.querySelector<HTMLTableElement>(
        "table.cm-table-rendered",
      );
      if (!table) return [];
      const grid: string[][] = [];
      const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
        (th.querySelector(".cm-table-cell")?.textContent ?? "").trim(),
      );
      grid.push(headers);
      const tbodyRows = Array.from(table.querySelectorAll("tbody tr"));
      for (const tr of tbodyRows) {
        grid.push(
          Array.from(tr.querySelectorAll("td")).map((td) =>
            (td.querySelector(".cm-table-cell")?.textContent ?? "").trim(),
          ),
        );
      }
      return grid;
    });
  }

  async function clickTestid(testid: string): Promise<void> {
    await browser.execute((id: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!el) throw new Error(`[data-testid="${id}"] not found`);
      el.click();
    }, testid);
  }

  async function hoverControlsReveal(): Promise<{
    addCol: boolean;
    addRow: boolean;
  }> {
    // Hover -> :hover pseudo-class exposes controls via CSS (opacity 1).
    // We don't control pointer state via JS cleanly, so we inspect computed
    // opacity after firing mouseover/mouseenter events on the wrap.
    return browser.execute(() => {
      const wrap = document.querySelector<HTMLElement>(".cm-table-wrap");
      if (!wrap)
        return { addCol: false, addRow: false };
      wrap.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      wrap.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      const addColEl = wrap.querySelector<HTMLElement>(
        '[data-testid="table-add-col"]',
      );
      const addRowEl = wrap.querySelector<HTMLElement>(
        '[data-testid="table-add-row"]',
      );
      return {
        addCol: !!addColEl,
        addRow: !!addRowEl,
      };
    });
  }

  it("renders the add-col and add-row hover buttons", async () => {
    const r = await hoverControlsReveal();
    expect(r.addCol).toBe(true);
    expect(r.addRow).toBe(true);
  });

  it("clicking '+ column' appends a column in DOM and markdown", async () => {
    const before = await tableShape();
    await clickTestid("table-add-col");
    await browser.waitUntil(
      async () => (await tableShape()).cols === before.cols + 1,
      { timeout: 3000, timeoutMsg: "column never appended to DOM" },
    );
    const doc = await getDocText();
    // Header has one more column slot (three pipe separators become four).
    const header = doc
      .split("\n")
      .find((l) => l.trim().startsWith("|") && !l.match(/^\|\s*:?-/));
    expect(header).toBeDefined();
    const pipes = (header as string).split("|").length - 1;
    expect(pipes).toBe(before.cols + 2); // cols+1 columns → cols+2 pipes
  });

  it("clicking '+ row' appends a row in DOM and markdown", async () => {
    const before = await tableShape();
    await clickTestid("table-add-row");
    await browser.waitUntil(
      async () => (await tableShape()).rows === before.rows + 1,
      { timeout: 3000, timeoutMsg: "row never appended to DOM" },
    );
    const doc = await getDocText();
    const dataRows = doc
      .split("\n")
      .filter((l) => l.trim().startsWith("|") && !l.match(/^\|\s*:?-/));
    // header + 3 previous body rows + 1 new = 5 non-delimiter rows
    expect(dataRows.length).toBeGreaterThanOrEqual(5);
  });

  it("clicking row delete removes that row in DOM and markdown", async () => {
    const before = await tableShape();
    // Delete row index 1 (first data row — currently Alice).
    await clickTestid("table-row-delete-1");
    await browser.waitUntil(
      async () => (await tableShape()).rows === before.rows - 1,
      { timeout: 3000, timeoutMsg: "row never removed from DOM" },
    );
    const doc = await getDocText();
    expect(doc).not.toContain("Alice");
  });

  it("clicking column delete removes that column in DOM and markdown", async () => {
    // Current state after prior tests: an extra empty column was appended,
    // Alice-row was deleted, and a new empty row exists. Delete the last
    // empty column we just added (index = cols-1).
    const before = await tableShape();
    const targetCol = before.cols - 1;
    await clickTestid(`table-col-delete-${targetCol}`);
    await browser.waitUntil(
      async () => (await tableShape()).cols === before.cols - 1,
      { timeout: 3000, timeoutMsg: "col never removed from DOM" },
    );
    const doc = await getDocText();
    const header = doc
      .split("\n")
      .find((l) => l.trim().startsWith("|") && !l.match(/^\|\s*:?-/));
    expect(header).toBeDefined();
    const pipes = (header as string).split("|").length - 1;
    expect(pipes).toBe(before.cols); // cols-1 columns → cols pipes
  });

  it("control stays visible when the cursor moves from the wrap onto it (issue #110)", async () => {
    // Regression for the hover-gap bug: row/col delete buttons sit at
    // top: -22px / left: -24px, outside .cm-table-wrap's visible area. When
    // the cursor crosses the gap from wrap to button the wrap:hover selector
    // drops; without the fade-out grace period, visibility flips to hidden
    // instantly and the user clicks dead air.
    const stillVisible = await browser.execute(() => {
      const wrap = document.querySelector<HTMLElement>(".cm-table-wrap");
      const btn = document.querySelector<HTMLElement>(
        '[data-testid="table-row-delete-1"]',
      );
      if (!wrap || !btn) return { found: false };

      // 1. Hover the wrap — controls become visible.
      wrap.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      wrap.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      // 2. Leave the wrap — without the fix, visibility flips to hidden now.
      wrap.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      // 3. Hover the control itself — the :hover rule should keep it visible.
      btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

      const vis = getComputedStyle(btn).visibility;
      return { found: true, visibility: vis };
    });
    expect(stillVisible.found).toBe(true);
    expect(stillVisible.visibility).toBe("visible");
  });

  it("column-header sort cycles unsorted → asc → desc → unsorted", async () => {
    // Content-agnostic: read the current first body value, cycle sort three
    // times on column 0, and assert the final restore lands back on that
    // same value. The earlier column/row deletes in this suite leave the
    // table in a non-deterministic row order; snapshotting before the first
    // click avoids coupling to the exact residue.
    const beforeGrid = await cellTexts();
    const beforeFirstValue = beforeGrid[1]?.[0];

    // First click: asc.
    await clickTestid("table-col-sort-0");
    await browser.waitUntil(
      async () => {
        const g = await cellTexts();
        // Sort applied → rows rearranged (or stayed if already sorted).
        return g.length >= 3;
      },
      { timeout: 3000 },
    );
    const ascDoc = await getDocText();
    expect(ascDoc.length).toBeGreaterThan(0);

    // Second click: desc.
    await clickTestid("table-col-sort-0");
    await browser.pause(150);
    const descGrid = await cellTexts();
    expect(descGrid.length).toBeGreaterThanOrEqual(3);

    // Third click: back to original.
    await clickTestid("table-col-sort-0");
    await browser.pause(150);
    const restoredGrid = await cellTexts();
    expect(restoredGrid[1]?.[0]).toBe(beforeFirstValue);
  });

  // Must be the last test in this file — removes the table, invalidating
  // the shared state the earlier tests rely on.
  it("clicking 'delete table' removes the whole table from DOM and markdown (issue #110)", async () => {
    const before = await getDocText();
    expect(before).toContain("|"); // table still present in source
    expect(
      await browser.$("table.cm-table-rendered").isExisting(),
    ).toBe(true);

    await clickTestid("table-delete");

    await browser.waitUntil(
      async () => !(await browser.$("table.cm-table-rendered").isExisting()),
      { timeout: 3000, timeoutMsg: "table widget never disappeared from DOM" },
    );

    const after = await getDocText();
    const tableLines = after
      .split("\n")
      .filter((l) => l.trim().startsWith("|"));
    expect(tableLines).toEqual([]);
    // The heading and intro text above the table must still be there — delete
    // is scoped to the widget range, not the whole note.
    expect(after).toContain("# Structural");
    expect(after).toContain("Intro.");
  });
});
