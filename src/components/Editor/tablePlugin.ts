// GFM table rendering + inline editing CM6 plugin (#99 → #101).
//
// Finds `Table` nodes in the Lezer tree and replaces them with a rendered
// <table> widget that stays mounted regardless of cursor position. Cells are
// contenteditable; edits dispatch a minimal CM6 change back into the
// pipe-delimited source. The decoration is built from a StateField because
// CM6 requires block-level replace decorations to come from a StateField.

import {
  Decoration,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import {
  Annotation,
  EditorState,
  StateField,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";

// ── Types ────────────────────────────────────────────────────────────────────

type Align = "left" | "center" | "right" | "default";

interface ParsedTable {
  headers: string[];
  alignments: Align[];
  rows: string[][];
}

// Marks transactions that originate from a cell edit inside a rendered table.
// When set, the StateField remaps decoration positions instead of rebuilding
// the widget — the DOM (and the browser's caret) survives the keystroke.
const tableCellEdit = Annotation.define<boolean>();

// ── Parsing (exported for tests) ─────────────────────────────────────────────

/** Parse alignment specs from a GFM delimiter row like `|:---|:---:|---:|` */
export function parseAlignments(delimiterText: string): Align[] {
  const cols = delimiterText.replace(/^\||\|$/g, "").split("|");
  return cols.map((col) => {
    const trimmed = col.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "default";
  });
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const DELIMITER_RE = /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/;

/** Parse a GFM table from raw pipe-delimited text. Exported for testing. */
export function parseTableText(text: string): ParsedTable | null {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const headerLine = lines[0]!;
  const delimiterLine = lines[1]!;
  if (!DELIMITER_RE.test(delimiterLine.trim())) return null;

  const headers = splitRow(headerLine);
  const alignments = parseAlignments(delimiterLine);
  while (alignments.length < headers.length) alignments.push("default");

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]!);
    while (cells.length < headers.length) cells.push("");
    rows.push(cells.slice(0, headers.length));
  }

  return { headers, alignments, rows };
}

// ── Serialization (exported for tests) ───────────────────────────────────────

/**
 * Serialize a ParsedTable back to pipe-delimited markdown, padding each
 * column to its max-content width + one space on each side. Alignment is
 * re-emitted on the delimiter row and reflected in the cell padding
 * direction (left/default → pad right, right → pad left, center → split).
 */
export function serializeTable(table: ParsedTable): string {
  const cols = Math.max(1, table.headers.length);
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) {
    let w = (table.headers[i] ?? "").length;
    for (const row of table.rows) {
      w = Math.max(w, (row[i] ?? "").length);
    }
    widths.push(Math.max(1, w));
  }

  const padCell = (content: string, width: number, align: Align): string => {
    const pad = Math.max(0, width - content.length);
    if (pad === 0) return content;
    if (align === "right") return " ".repeat(pad) + content;
    if (align === "center") {
      const left = Math.floor(pad / 2);
      return " ".repeat(left) + content + " ".repeat(pad - left);
    }
    return content + " ".repeat(pad); // default / left
  };

  const formatRow = (cells: string[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < cols; i++) {
      parts.push(" " + padCell(cells[i] ?? "", widths[i]!, table.alignments[i] ?? "default") + " ");
    }
    return "|" + parts.join("|") + "|";
  };

  const formatDelimiter = (): string => {
    const parts: string[] = [];
    for (let i = 0; i < cols; i++) {
      const w = Math.max(3, widths[i]!);
      const align = table.alignments[i] ?? "default";
      let spec: string;
      if (align === "left") spec = ":" + "-".repeat(w - 1);
      else if (align === "right") spec = "-".repeat(w - 1) + ":";
      else if (align === "center") spec = ":" + "-".repeat(Math.max(1, w - 2)) + ":";
      else spec = "-".repeat(w);
      parts.push(" " + spec + " ");
    }
    return "|" + parts.join("|") + "|";
  };

  const lines: string[] = [formatRow(table.headers), formatDelimiter()];
  for (const row of table.rows) lines.push(formatRow(row));
  return lines.join("\n");
}

// ── Minimal source diff (keeps decoration range stable) ──────────────────────

interface MinDiff {
  from: number;
  to: number;
  insert: string;
}

/** Compute the minimal {from, to, insert} edit that turns `oldStr` into `newStr`. */
function minDiff(oldStr: string, newStr: string): MinDiff | null {
  if (oldStr === newStr) return null;
  let prefix = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (prefix < minLen && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (
    oldEnd > prefix &&
    newEnd > prefix &&
    oldStr.charCodeAt(oldEnd - 1) === newStr.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  return {
    from: prefix,
    to: oldEnd,
    insert: newStr.substring(prefix, newEnd),
  };
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

interface TableCtx {
  from: number;
  to: number;
  table: ParsedTable;
  view: EditorView;
}

interface TableDomWithCtx extends HTMLElement {
  __tableCtx?: TableCtx;
}

function applyAlign(cell: HTMLElement, align: Align): void {
  if (align && align !== "default") {
    cell.style.textAlign = align;
  } else {
    cell.style.removeProperty("text-align");
  }
}

function cellInner(cell: HTMLElement): HTMLElement {
  return cell.querySelector<HTMLElement>(".cm-table-cell") ?? cell;
}

function cellText(cell: HTMLElement): string {
  // Read the .cm-table-cell span's text (contenteditable surface). Falls back
  // to the cell's own textContent when the span is missing — e.g. during
  // tests that build a bare <td>.
  return (cellInner(cell).textContent ?? "").replace(/\r?\n/g, " ").trim();
}

function syncCellText(cell: HTMLElement, expected: string): void {
  const inner = cellInner(cell);
  if (inner.textContent !== expected) inner.textContent = expected;
}

function buildCellElement(
  tag: "th" | "td",
  text: string,
  align: Align,
  row: number,
  col: number,
): HTMLTableCellElement {
  const cell = document.createElement(tag) as HTMLTableCellElement;
  applyAlign(cell, align);
  const inner = document.createElement("span");
  inner.className = "cm-table-cell";
  inner.setAttribute("contenteditable", "true");
  inner.setAttribute("data-cell-row", String(row));
  inner.setAttribute("data-cell-col", String(col));
  inner.spellcheck = false;
  inner.textContent = text;
  cell.appendChild(inner);
  return cell;
}

function findCell(wrap: HTMLElement, row: number, col: number): HTMLElement | null {
  return wrap.querySelector<HTMLElement>(
    `.cm-table-cell[data-cell-row="${row}"][data-cell-col="${col}"]`,
  );
}

function selectCellContent(cell: HTMLElement): void {
  cell.focus();
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || typeof document === "undefined") return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(cell: HTMLElement): void {
  cell.focus();
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || typeof document === "undefined") return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function buildTableDom(
  table: ParsedTable,
  from: number,
  to: number,
  view: EditorView,
): HTMLElement {
  const wrap = document.createElement("div") as TableDomWithCtx;
  wrap.className = "cm-table-wrap";
  wrap.__tableCtx = { from, to, table, view };

  const el = document.createElement("table");
  el.className = "cm-table-rendered";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const sortState = getSortState(from);
  for (let i = 0; i < table.headers.length; i++) {
    const th = buildCellElement(
      "th",
      table.headers[i] ?? "",
      table.alignments[i] ?? "default",
      0,
      i,
    );
    const sortDir = sortState && sortState.col === i ? sortState.dir : null;
    th.appendChild(buildColControls(i, sortDir));
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  el.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let r = 0; r < table.rows.length; r++) {
    const tr = document.createElement("tr");
    tr.setAttribute("data-row-idx", String(r + 1));
    for (let i = 0; i < table.headers.length; i++) {
      const td = buildCellElement(
        "td",
        table.rows[r]![i] ?? "",
        table.alignments[i] ?? "default",
        r + 1,
        i,
      );
      if (i === 0) td.appendChild(buildRowControls(r + 1));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  el.appendChild(tbody);

  wrap.appendChild(el);
  wrap.appendChild(buildAddColButton());
  wrap.appendChild(buildAddRowButton());
  wrap.appendChild(buildDeleteTableButton());

  attachCellHandlers(wrap);
  attachStructuralHandlers(wrap);
  return wrap;
}

// ── Hover / structural controls ──────────────────────────────────────────────

function buildAddColButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-table-ctrl cm-table-add-col-btn";
  b.setAttribute("aria-label", "Spalte hinzufügen");
  b.setAttribute("data-testid", "table-add-col");
  b.textContent = "+";
  return b;
}

function buildAddRowButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-table-ctrl cm-table-add-row-btn";
  b.setAttribute("aria-label", "Zeile hinzufügen");
  b.setAttribute("data-testid", "table-add-row");
  b.textContent = "+";
  return b;
}

function buildDeleteTableButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-table-ctrl cm-table-delete-btn";
  b.setAttribute("aria-label", "Tabelle löschen");
  b.setAttribute("data-testid", "table-delete");
  // Unicode wastebasket is distinct from the per-column/-row "×" so the
  // table-level action is not confused with a per-cell delete.
  b.textContent = "🗑";
  return b;
}

function buildColControls(col: number, sortDir: "asc" | "desc" | null): HTMLElement {
  const box = document.createElement("span");
  box.className = "cm-table-col-ctrls cm-table-ctrl";
  box.setAttribute("contenteditable", "false");

  const sort = document.createElement("button");
  sort.type = "button";
  sort.className = "cm-table-col-sort";
  sort.setAttribute("data-col-sort", String(col));
  sort.setAttribute("data-testid", `table-col-sort-${col}`);
  sort.setAttribute("aria-label", "Spalte sortieren");
  sort.textContent = sortDir === "asc" ? "↑" : sortDir === "desc" ? "↓" : "↕";
  box.appendChild(sort);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "cm-table-col-delete";
  del.setAttribute("data-col-delete", String(col));
  del.setAttribute("data-testid", `table-col-delete-${col}`);
  del.setAttribute("aria-label", "Spalte löschen");
  del.textContent = "×";
  box.appendChild(del);

  return box;
}

function buildRowControls(row: number): HTMLElement {
  const box = document.createElement("span");
  box.className = "cm-table-row-ctrls cm-table-ctrl";
  box.setAttribute("contenteditable", "false");

  const del = document.createElement("button");
  del.type = "button";
  del.className = "cm-table-row-delete";
  del.setAttribute("data-row-delete", String(row));
  del.setAttribute("data-testid", `table-row-delete-${row}`);
  del.setAttribute("aria-label", "Zeile löschen");
  del.textContent = "×";
  box.appendChild(del);

  return box;
}

// ── Sort state (module-level, keyed by table-start position) ─────────────────

interface SortState {
  col: number;
  dir: "asc" | "desc";
  originalOrder: string[][];
}

const sortStates: Map<number, SortState> = new Map();

function getSortState(from: number): SortState | undefined {
  return sortStates.get(from);
}

function applySort(table: ParsedTable, state: SortState): ParsedTable {
  const sorted = table.rows.map((r) => r.slice());
  const col = state.col;
  sorted.sort((a, b) => {
    const av = (a[col] ?? "").toLowerCase();
    const bv = (b[col] ?? "").toLowerCase();
    const an = Number(a[col]);
    const bn = Number(b[col]);
    const numeric = !Number.isNaN(an) && !Number.isNaN(bn);
    const cmp = numeric ? an - bn : av < bv ? -1 : av > bv ? 1 : 0;
    return state.dir === "asc" ? cmp : -cmp;
  });
  return { ...table, rows: sorted };
}

// ── Structural mutations ─────────────────────────────────────────────────────

function withAppendedColumn(table: ParsedTable): ParsedTable {
  return {
    headers: [...table.headers, ""],
    alignments: [...table.alignments, "default"],
    rows: table.rows.map((r) => [...r, ""]),
  };
}

function withRemovedColumn(table: ParsedTable, col: number): ParsedTable {
  if (table.headers.length <= 1) return table;
  const removeAt = (arr: string[]): string[] => arr.filter((_, i) => i !== col);
  return {
    headers: removeAt(table.headers),
    alignments: table.alignments.filter((_, i) => i !== col),
    rows: table.rows.map(removeAt),
  };
}

function withRemovedRow(table: ParsedTable, row: number): ParsedTable {
  // row: 1..N (header cannot be removed via row delete).
  if (row <= 0 || row > table.rows.length) return table;
  const rows = table.rows.slice();
  rows.splice(row - 1, 1);
  return { ...table, rows };
}

// ── Structural event handlers ────────────────────────────────────────────────

function attachStructuralHandlers(wrap: TableDomWithCtx): void {
  wrap.addEventListener("click", (event) => {
    const ctx = wrap.__tableCtx;
    if (!ctx) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.closest(".cm-table-add-col-btn")) {
      event.preventDefault();
      const newTable = withAppendedColumn(readTableFromDom(wrap));
      commitStructuralChange(wrap, newTable);
      return;
    }
    if (target.closest(".cm-table-add-row-btn")) {
      event.preventDefault();
      const newTable = withAppendedRow(readTableFromDom(wrap));
      commitStructuralChange(wrap, newTable);
      return;
    }
    if (target.closest(".cm-table-delete-btn")) {
      event.preventDefault();
      deleteTable(wrap);
      return;
    }

    const colDelete = target.closest<HTMLElement>("[data-col-delete]");
    if (colDelete) {
      event.preventDefault();
      const col = parseInt(colDelete.getAttribute("data-col-delete") ?? "-1", 10);
      const newTable = withRemovedColumn(readTableFromDom(wrap), col);
      commitStructuralChange(wrap, newTable);
      return;
    }
    const rowDelete = target.closest<HTMLElement>("[data-row-delete]");
    if (rowDelete) {
      event.preventDefault();
      const row = parseInt(rowDelete.getAttribute("data-row-delete") ?? "-1", 10);
      const newTable = withRemovedRow(readTableFromDom(wrap), row);
      commitStructuralChange(wrap, newTable);
      return;
    }
    const sortBtn = target.closest<HTMLElement>("[data-col-sort]");
    if (sortBtn) {
      event.preventDefault();
      const col = parseInt(sortBtn.getAttribute("data-col-sort") ?? "-1", 10);
      cycleSort(wrap, col);
      return;
    }
  });
}

function cycleSort(wrap: TableDomWithCtx, col: number): void {
  const ctx = wrap.__tableCtx;
  if (!ctx) return;
  const tableFrom = ctx.from;
  const current = sortStates.get(tableFrom);
  const currentTable = readTableFromDom(wrap);

  if (!current || current.col !== col) {
    const state: SortState = {
      col,
      dir: "asc",
      originalOrder: currentTable.rows.map((r) => r.slice()),
    };
    sortStates.set(tableFrom, state);
    commitStructuralChange(wrap, applySort(currentTable, state));
    return;
  }
  if (current.dir === "asc") {
    const state: SortState = { ...current, dir: "desc" };
    sortStates.set(tableFrom, state);
    commitStructuralChange(wrap, applySort(currentTable, state));
    return;
  }
  // desc → unsorted: restore the original row order captured on the first click.
  const restored: ParsedTable = { ...currentTable, rows: current.originalOrder };
  sortStates.delete(tableFrom);
  commitStructuralChange(wrap, restored);
}

function readTableFromDom(wrap: TableDomWithCtx): ParsedTable {
  const ctx = wrap.__tableCtx!;
  const alignments = ctx.table.alignments;
  const headerCells = Array.from(wrap.querySelectorAll("thead th")) as HTMLElement[];
  const headers = headerCells.map(cellText);
  const bodyRows = Array.from(wrap.querySelectorAll("tbody tr")) as HTMLElement[];
  const rows: string[][] = bodyRows.map((tr) => {
    const tds = Array.from(tr.querySelectorAll("td")) as HTMLElement[];
    return tds.map(cellText);
  });
  const cols = headers.length;
  const aligns = alignments.slice(0, cols);
  while (aligns.length < cols) aligns.push("default");
  return { headers, alignments: aligns, rows };
}

function commitTableFromDom(wrap: TableDomWithCtx): void {
  const ctx = wrap.__tableCtx;
  if (!ctx) return;
  const view = ctx.view;
  const newTable = readTableFromDom(wrap);
  const newSource = serializeTable(newTable);
  const currentSource = view.state.doc.sliceString(ctx.from, ctx.to);
  const diff = minDiff(currentSource, newSource);
  if (!diff) return;

  view.dispatch({
    changes: {
      from: ctx.from + diff.from,
      to: ctx.from + diff.to,
      insert: diff.insert,
    },
    annotations: [tableCellEdit.of(true)],
    userEvent: "input",
  });

  ctx.to = ctx.from + newSource.length;
  ctx.table = newTable;
}

/**
 * Dispatch a full structural replacement of the table source. Unlike cell
 * edits, this lets the StateField rebuild the widget so the new structure
 * (added/removed rows/columns, reordered rows, etc.) is reflected in the DOM.
 * After CM6 finishes re-rendering, `focusAfter` fires — callers use it to
 * restore focus/caret to the appropriate cell.
 */
function commitStructuralChange(
  wrap: TableDomWithCtx,
  newTable: ParsedTable,
  focusAfter?: (newWrap: HTMLElement) => void,
): void {
  const ctx = wrap.__tableCtx;
  if (!ctx) return;
  const view = ctx.view;
  const newSource = serializeTable(newTable);
  const tableFrom = ctx.from;
  view.dispatch({
    changes: { from: ctx.from, to: ctx.to, insert: newSource },
    userEvent: "input",
  });
  if (focusAfter) {
    requestAnimationFrame(() => {
      const newWrap = findTableWrapAt(view, tableFrom);
      if (newWrap) focusAfter(newWrap);
    });
  }
}

/**
 * Remove the entire table block. Dispatches a single delete transaction over
 * the widget's source range, plus the trailing newline so the surrounding
 * paragraph flow doesn't leave a stranded blank line where the table used to
 * sit. The StateField re-parses on the next change and the atomic widget
 * disappears together with its source.
 */
function deleteTable(wrap: TableDomWithCtx): void {
  const ctx = wrap.__tableCtx;
  if (!ctx) return;
  const view = ctx.view;
  const doc = view.state.doc;
  let to = ctx.to;
  if (to < doc.length && doc.sliceString(to, to + 1) === "\n") {
    to += 1;
  }
  view.dispatch({
    changes: { from: ctx.from, to, insert: "" },
    selection: { anchor: ctx.from },
    userEvent: "delete",
  });
}

function findTableWrapAt(view: EditorView, from: number): HTMLElement | null {
  const wraps = Array.from(
    view.contentDOM.querySelectorAll<TableDomWithCtx>(".cm-table-wrap"),
  );
  for (const w of wraps) {
    if (w.__tableCtx?.from === from) return w;
  }
  return wraps[0] ?? null;
}

// ── Navigation ───────────────────────────────────────────────────────────────

/** rowIdx: 0 = header, 1..N = data rows. */
function readCellCoords(target: HTMLElement): { row: number; col: number } | null {
  const r = target.getAttribute("data-cell-row");
  const c = target.getAttribute("data-cell-col");
  if (r === null || c === null) return null;
  return { row: parseInt(r, 10), col: parseInt(c, 10) };
}

function handleTabNavigation(wrap: TableDomWithCtx, from: HTMLElement, back: boolean): void {
  const ctx = wrap.__tableCtx;
  if (!ctx) return;
  const coords = readCellCoords(from);
  if (!coords) return;
  const cols = ctx.table.headers.length;
  const totalRows = 1 + ctx.table.rows.length;
  const { row, col } = coords;

  let nextRow = row;
  let nextCol = back ? col - 1 : col + 1;
  if (nextCol >= cols) {
    nextCol = 0;
    nextRow += 1;
  } else if (nextCol < 0) {
    nextCol = cols - 1;
    nextRow -= 1;
  }

  if (nextRow >= totalRows) {
    // Tab past the last cell of the last row → append a new empty row and
    // focus its first cell.
    const newTable = withAppendedRow(readTableFromDom(wrap));
    commitStructuralChange(wrap, newTable, (newWrap) => {
      const cell = findCell(newWrap, totalRows, 0);
      if (cell) selectCellContent(cell);
    });
    return;
  }
  if (nextRow < 0) {
    // Shift+Tab past the first header cell → stay (don't drop focus).
    return;
  }

  const target = findCell(wrap, nextRow, nextCol);
  if (target) selectCellContent(target);
}

function handleEnterNavigation(wrap: TableDomWithCtx, from: HTMLElement): void {
  const ctx = wrap.__tableCtx;
  if (!ctx) return;
  const coords = readCellCoords(from);
  if (!coords) return;
  const totalRows = 1 + ctx.table.rows.length;
  const { row, col } = coords;
  const nextRow = row + 1;

  if (nextRow >= totalRows) {
    const newTable = withAppendedRow(readTableFromDom(wrap));
    commitStructuralChange(wrap, newTable, (newWrap) => {
      const cell = findCell(newWrap, totalRows, col);
      if (cell) selectCellContent(cell);
    });
    return;
  }

  const target = findCell(wrap, nextRow, col);
  if (target) selectCellContent(target);
}

function handleEscape(wrap: TableDomWithCtx): void {
  const ctx = wrap.__tableCtx;
  if (!ctx) return;
  const view = ctx.view;
  view.dispatch({ selection: { anchor: ctx.to } });
  view.focus();
}

function withAppendedRow(table: ParsedTable): ParsedTable {
  const cols = table.headers.length;
  const newRow: string[] = new Array(cols).fill("");
  return {
    headers: table.headers.slice(),
    alignments: table.alignments.slice(),
    rows: [...table.rows, newRow],
  };
}

function attachCellHandlers(wrap: TableDomWithCtx): void {
  wrap.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.classList?.contains("cm-table-cell")) return;
    commitTableFromDom(wrap);
  });

  wrap.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.classList?.contains("cm-table-cell")) return;

    const ctx = wrap.__tableCtx;
    if (!ctx) return;

    // Route Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y to CM6's history so
    // cell edits participate in the editor-wide undo/redo stack.
    if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (event.shiftKey) redo(ctx.view);
      else undo(ctx.view);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y")) {
      event.preventDefault();
      redo(ctx.view);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      handleTabNavigation(wrap, target, event.shiftKey);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      handleEnterNavigation(wrap, target);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleEscape(wrap);
      return;
    }
  });

  // Pipes inside a cell would break GFM delimiter rules. Intercept
  // beforeinput and rewrite "|" insertions to the escaped "\\|" that Obsidian
  // also uses. We still let the browser perform the insertion so the caret
  // stays at the right offset.
  wrap.addEventListener("beforeinput", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.classList?.contains("cm-table-cell")) return;
    if (event.inputType === "insertText" && event.data === "|") {
      event.preventDefault();
      document.execCommand("insertText", false, "\\|");
    }
  });
}

// ── Widget ───────────────────────────────────────────────────────────────────

class TableWidget extends WidgetType {
  constructor(
    readonly table: ParsedTable,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    if (this.from !== other.from || this.to !== other.to) return false;
    return serializeTable(this.table) === serializeTable(other.table);
  }

  toDOM(view: EditorView): HTMLElement {
    return buildTableDom(this.table, this.from, this.to, view);
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const wrap = dom as TableDomWithCtx;
    const ctx = wrap.__tableCtx;
    if (!ctx) return false;

    // Structural mismatch (cols/rows added or removed) → let CM6 rebuild.
    const newCols = this.table.headers.length;
    const newRows = this.table.rows.length;
    const oldCols = ctx.table.headers.length;
    const oldRows = ctx.table.rows.length;
    if (newCols !== oldCols || newRows !== oldRows) return false;

    const thead = wrap.querySelector("thead");
    if (thead) {
      const ths = Array.from(thead.querySelectorAll("th")) as HTMLTableCellElement[];
      for (let i = 0; i < ths.length; i++) {
        syncCellText(ths[i]!, this.table.headers[i] ?? "");
        applyAlign(ths[i]!, this.table.alignments[i] ?? "default");
      }
    }
    const tbody = wrap.querySelector("tbody");
    if (tbody) {
      const trs = Array.from(tbody.querySelectorAll("tr")) as HTMLTableRowElement[];
      for (let r = 0; r < trs.length; r++) {
        const tds = Array.from(trs[r]!.querySelectorAll("td")) as HTMLTableCellElement[];
        for (let c = 0; c < tds.length; c++) {
          syncCellText(tds[c]!, this.table.rows[r]?.[c] ?? "");
          applyAlign(tds[c]!, this.table.alignments[c] ?? "default");
        }
      }
    }

    ctx.from = this.from;
    ctx.to = this.to;
    ctx.table = this.table;
    ctx.view = view;
    return true;
  }

  ignoreEvent(): boolean {
    // CM6 must not process events inside the widget — the cell handlers own
    // input/keydown and dispatch their own transactions.
    return true;
  }
}

// ── Decoration builder ───────────────────────────────────────────────────────

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  const doc = state.doc;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;

      const from = node.from;
      const to = node.to;
      const text = doc.sliceString(from, to);
      const parsed = parseTableText(text);
      if (!parsed) return;

      ranges.push({
        from,
        to,
        decoration: Decoration.replace({
          widget: new TableWidget(parsed, from, to),
          block: true,
        }),
      });
    },
  });

  ranges.sort((a, b) => a.from - b.from);

  return Decoration.set(
    ranges.map((r) => r.decoration.range(r.from, r.to)),
    true,
  );
}

// ── StateField ───────────────────────────────────────────────────────────────

const tableField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.annotation(tableCellEdit)) {
      // Cell-edit transactions only need position remapping — no rebuild,
      // so the widget DOM (and the browser's caret) stays intact.
      return value.map(tr.changes);
    }
    if (tr.docChanged || tr.selection) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

// Expose table decorations as atomic — arrow keys / selection motion skip
// past the widget rather than descending into the underlying pipe source.
const tableAtomic = EditorView.atomicRanges.of((view) =>
  view.state.field(tableField, false) ?? Decoration.none,
);

export const tablePlugin: Extension = [tableField, tableAtomic];
