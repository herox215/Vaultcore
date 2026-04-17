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
  return (cellInner(cell).textContent ?? "").replace(/\r?\n/g, " ").trim();
}

function syncCellText(cell: HTMLElement, expected: string): void {
  const inner = cellInner(cell);
  if (inner.textContent !== expected) inner.textContent = expected;
}

function buildCellElement(tag: "th" | "td", text: string, align: Align): HTMLTableCellElement {
  const cell = document.createElement(tag) as HTMLTableCellElement;
  applyAlign(cell, align);
  const inner = document.createElement("span");
  inner.className = "cm-table-cell";
  inner.setAttribute("contenteditable", "true");
  inner.spellcheck = false;
  inner.textContent = text;
  cell.appendChild(inner);
  return cell;
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
  for (let i = 0; i < table.headers.length; i++) {
    headerRow.appendChild(
      buildCellElement("th", table.headers[i] ?? "", table.alignments[i] ?? "default"),
    );
  }
  thead.appendChild(headerRow);
  el.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    for (let i = 0; i < table.headers.length; i++) {
      tr.appendChild(
        buildCellElement("td", row[i] ?? "", table.alignments[i] ?? "default"),
      );
    }
    tbody.appendChild(tr);
  }
  el.appendChild(tbody);

  wrap.appendChild(el);
  attachCellHandlers(wrap);
  return wrap;
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

    // Prevent raw newlines / tabs from entering cells. Commit 2 wires Tab /
    // Enter / Escape to navigation; until then, swallowing them keeps cell
    // content clean.
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
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
