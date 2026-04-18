import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * Cell-level AC from issue #101:
 *  - Clicking a cell places the cursor inside the rendered cell.
 *  - Typing in a cell updates the underlying markdown source.
 *  - Tab / Shift+Tab cycles cells left-to-right, top-to-bottom.
 *  - Enter moves to the same column in the next row.
 *  - Escape exits table editing and returns focus to the CM6 editor.
 *  - Edits preserve pipe alignment in the serialized source.
 *  - Undo / redo spans cell edits.
 *
 * WebKitWebDriver can't introspect CM6 via the element API, so the whole
 * test runs via `browser.execute` against real DOM nodes. Document contents
 * are read back through the __e2e__.getActiveDocText hook.
 */

describe("Inline table editing — cells", () => {
  let vault: TestVault;

  const TABLE_LINES = [
    "# Cell Edit",
    "",
    "Intro.",
    "",
    "| Name  | Age |",
    "| ----- | --- |",
    "| Alice |  30 |",
    "| Bob   |  42 |",
    "",
  ];

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Cell Edit.md"),
      TABLE_LINES.join("\n"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
    await openTreeFile("Cell Edit.md");
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

  async function focusCell(row: number, col: number): Promise<void> {
    await browser.execute(
      (r: number, c: number) => {
        const sel =
          `.cm-table-cell[data-cell-row="${r}"][data-cell-col="${c}"]`;
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`cell ${r},${c} not found`);
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(range);
      },
      row,
      col,
    );
  }

  async function activeCellCoords(): Promise<{ row: number; col: number } | null> {
    return browser.execute(() => {
      const a = document.activeElement as HTMLElement | null;
      if (!a?.classList.contains("cm-table-cell")) return null;
      return {
        row: parseInt(a.getAttribute("data-cell-row") ?? "-1", 10),
        col: parseInt(a.getAttribute("data-cell-col") ?? "-1", 10),
      };
    });
  }

  async function replaceCellText(
    row: number,
    col: number,
    text: string,
  ): Promise<void> {
    await browser.execute(
      (r: number, c: number, t: string) => {
        const sel =
          `.cm-table-cell[data-cell-row="${r}"][data-cell-col="${c}"]`;
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`cell ${r},${c} not found`);
        el.focus();
        el.textContent = t;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      row,
      col,
      text,
    );
  }

  async function pressKey(
    row: number,
    col: number,
    key: string,
    shift = false,
  ): Promise<void> {
    await browser.execute(
      (r: number, c: number, k: string, sh: boolean) => {
        const sel =
          `.cm-table-cell[data-cell-row="${r}"][data-cell-col="${c}"]`;
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`cell ${r},${c} not found`);
        el.focus();
        const event = new KeyboardEvent("keydown", {
          key: k,
          shiftKey: sh,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
      },
      row,
      col,
      key,
      shift,
    );
  }

  it("places focus inside the rendered cell on click", async () => {
    await focusCell(1, 0);
    const coords = await activeCellCoords();
    expect(coords).toEqual({ row: 1, col: 0 });
  });

  it("typing in a cell updates the underlying markdown", async () => {
    await replaceCellText(1, 0, "Alicia");
    await browser.waitUntil(
      async () => (await getDocText()).includes("Alicia"),
      { timeout: 3000, timeoutMsg: "doc never reflected edit" },
    );
    const doc = await getDocText();
    expect(doc).toContain("Alicia");
    expect(doc).not.toContain(" Alice ");
  });

  it("preserves pipe alignment after an edit", async () => {
    // After editing "Alice"→"Alicia", the column grows. The serializer pads
    // each row to the new column width, so every row must still share the
    // same number of pipes and cell widths.
    const doc = await getDocText();
    const tableLines = doc.split("\n").filter((l) => l.trim().startsWith("|"));
    expect(tableLines.length).toBeGreaterThanOrEqual(4);
    const widths = tableLines.map((l) => l.length);
    const unique = Array.from(new Set(widths));
    expect(unique.length).toBe(1);
  });

  it("Tab moves to the next cell (left-to-right)", async () => {
    await focusCell(1, 0);
    await pressKey(1, 0, "Tab");
    expect(await activeCellCoords()).toEqual({ row: 1, col: 1 });
  });

  it("Shift+Tab moves to the previous cell", async () => {
    await focusCell(1, 1);
    await pressKey(1, 1, "Tab", true);
    expect(await activeCellCoords()).toEqual({ row: 1, col: 0 });
  });

  it("Tab at last column wraps to next row first column", async () => {
    await focusCell(1, 1);
    await pressKey(1, 1, "Tab");
    expect(await activeCellCoords()).toEqual({ row: 2, col: 0 });
  });

  it("Enter moves to the same column in the next row", async () => {
    await focusCell(1, 1);
    await pressKey(1, 1, "Enter");
    expect(await activeCellCoords()).toEqual({ row: 2, col: 1 });
  });

  it("Enter past the last row appends a new empty row", async () => {
    // Before: 2 data rows (row 1, row 2). Press Enter from the last row →
    // structural change dispatches, StateField rebuilds, a row-3 cell
    // appears. We wait for that DOM marker (rather than racing the doc).
    await focusCell(2, 0);
    await pressKey(2, 0, "Enter");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !!document.querySelector(
              '.cm-table-cell[data-cell-row="3"][data-cell-col="0"]',
            ),
        ),
      { timeout: 3000, timeoutMsg: "new row-3 cell never appeared" },
    );
    const doc = await getDocText();
    const pipeLines = doc.split("\n").filter((l) => l.trim().startsWith("|"));
    expect(pipeLines.length).toBeGreaterThanOrEqual(5);
  });

  it("Escape exits table editing and returns focus to CM6", async () => {
    await focusCell(1, 0);
    await pressKey(1, 0, "Escape");
    const inTable = await browser.execute(
      () =>
        document.activeElement?.classList?.contains("cm-table-cell") === true,
    );
    expect(inTable).toBe(false);
    const focusedCm = await browser.execute(() => {
      const a = document.activeElement as HTMLElement | null;
      if (!a) return false;
      return !!a.closest(".cm-content") || !!a.closest(".cm-editor");
    });
    expect(focusedCm).toBe(true);
  });

  it("Ctrl+Z undoes a cell edit, Ctrl+Shift+Z redoes it", async () => {
    await focusCell(2, 0);
    await replaceCellText(2, 0, "Robert");
    await browser.waitUntil(
      async () => (await getDocText()).includes("Robert"),
      { timeout: 3000 },
    );

    // Dispatch Ctrl+Z via the cell's keydown handler (routes to CM6 undo).
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(
        '.cm-table-cell[data-cell-row="2"][data-cell-col="0"]',
      );
      el?.focus();
      el?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await browser.waitUntil(
      async () => !(await getDocText()).includes("Robert"),
      { timeout: 3000, timeoutMsg: "undo never removed 'Robert'" },
    );

    // Redo.
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(
        '.cm-table-cell[data-cell-row="2"][data-cell-col="0"]',
      );
      el?.focus();
      el?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Z",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await browser.waitUntil(
      async () => (await getDocText()).includes("Robert"),
      { timeout: 3000, timeoutMsg: "redo never reapplied 'Robert'" },
    );
  });
});
