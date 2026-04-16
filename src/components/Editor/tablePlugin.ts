// GFM table rendering CM6 plugin (#99).
//
// Finds `Table` nodes in the Lezer tree and replaces them with a rendered
// HTML <table> widget when the cursor is outside the table. When the cursor
// is on any line of the table, raw pipe syntax is shown for editing.
//
// Uses a StateField (not ViewPlugin) because CM6 requires block-level
// replace decorations to come from a StateField.

import {
  Decoration,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

// ── Alignment parsing ────────────────────────────────────────────────────────

type Align = "left" | "center" | "right" | "default";

/** Parse alignment specs from a GFM delimiter row like `|:---|:---:|---:|` */
export function parseAlignments(delimiterText: string): Align[] {
  const cols = delimiterText
    .replace(/^\||\|$/g, "")
    .split("|");

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

// ── Table parsing from raw text ──────────────────────────────────────────────

interface ParsedTable {
  headers: string[];
  alignments: Align[];
  rows: string[][];
}

/** Split a pipe-delimited row into cell values, stripping leading/trailing pipes. */
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
  const rows: string[][] = [];

  for (let i = 2; i < lines.length; i++) {
    rows.push(splitRow(lines[i]!));
  }

  return { headers, alignments, rows };
}

// ── Widget ───────────────────────────────────────────────────────────────────

class TableWidget extends WidgetType {
  constructor(readonly table: ParsedTable) {
    super();
  }

  eq(other: TableWidget): boolean {
    return (
      JSON.stringify(this.table.headers) === JSON.stringify(other.table.headers) &&
      JSON.stringify(this.table.rows) === JSON.stringify(other.table.rows) &&
      JSON.stringify(this.table.alignments) === JSON.stringify(other.table.alignments)
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("table");
    el.className = "cm-table-rendered";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (let i = 0; i < this.table.headers.length; i++) {
      const th = document.createElement("th");
      th.textContent = this.table.headers[i] ?? "";
      this.applyAlign(th, i);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    el.appendChild(thead);

    if (this.table.rows.length > 0) {
      const tbody = document.createElement("tbody");
      for (const row of this.table.rows) {
        const tr = document.createElement("tr");
        for (let i = 0; i < this.table.headers.length; i++) {
          const td = document.createElement("td");
          td.textContent = row[i] ?? "";
          this.applyAlign(td, i);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      el.appendChild(tbody);
    }

    return el;
  }

  private applyAlign(cell: HTMLElement, index: number): void {
    const align = this.table.alignments[index];
    if (align && align !== "default") {
      cell.style.textAlign = align;
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── Decoration builder ───────────────────────────────────────────────────────

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];

  const head = state.selection.main.head;
  const doc = state.doc;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;

      const from = node.from;
      const to = node.to;

      const startLine = doc.lineAt(from).number;
      const endLine = doc.lineAt(to).number;
      const cursorLine = doc.lineAt(head).number;
      if (cursorLine >= startLine && cursorLine <= endLine) return;

      const text = doc.sliceString(from, to);
      const parsed = parseTableText(text);
      if (!parsed) return;

      ranges.push({
        from,
        to,
        decoration: Decoration.replace({
          widget: new TableWidget(parsed),
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
    if (tr.docChanged || tr.selection) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

export const tablePlugin: Extension = tableField;
