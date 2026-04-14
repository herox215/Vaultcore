import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// ── Types ──────────────────────────────────────────────────────────────────────

export type CalloutType =
  | "note"
  | "info"
  | "tip"
  | "success"
  | "question"
  | "warning"
  | "failure"
  | "danger"
  | "bug"
  | "example"
  | "quote"
  | "abstract"
  | "todo";

const VALID_TYPES: Set<string> = new Set<CalloutType>([
  "note", "info", "tip", "success", "question", "warning",
  "failure", "danger", "bug", "example", "quote", "abstract", "todo",
]);

function normalizeType(raw: string): CalloutType {
  const lower = raw.toLowerCase();
  if (VALID_TYPES.has(lower)) return lower as CalloutType;
  return "note";
}

export interface CalloutInfo {
  type: CalloutType;
  collapsibleMod: "+" | "-" | "";
  title: string;
  body: string;
  blockFrom: number;
  blockTo: number;
  firstLineFrom: number;
  firstLineTo: number;
}

// ── Regex ──────────────────────────────────────────────────────────────────────

// Matches the first line of a callout. Accepts one or more `>` prefixes so
// nested callouts (`> > [!note]`) parse as callouts of their own depth.
const CALLOUT_RE = /^(?:>\s*)+\[!([a-zA-Z]+)\]([+\-]?)\s*(.*)$/;

// Matches every leading `>` prefix on a line — one or more levels.
const BQ_PREFIX_RE = /^((?:>\s*)+)/;

// ── Parser (pure, exported for tests) ─────────────────────────────────────────

export function parseCallout(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
): CalloutInfo | null {
  const doc = state.doc;
  const firstLine = doc.lineAt(blockFrom);
  const firstLineText = firstLine.text;

  const m = CALLOUT_RE.exec(firstLineText);
  if (!m) return null;

  const rawType = m[1] ?? "note";
  const collapsibleMod = (m[2] as "+" | "-" | "") ?? "";
  const rawTitle = (m[3] ?? "").trim();
  const type = normalizeType(rawType);
  const title = rawTitle.length > 0
    ? rawTitle
    : type.charAt(0).toUpperCase() + type.slice(1);

  // Collect body lines
  const bodyLines: string[] = [];
  let lineStart = firstLine.to + 1;
  while (lineStart <= blockTo) {
    const line = doc.lineAt(lineStart);
    bodyLines.push(line.text);
    if (line.to >= blockTo) break;
    lineStart = line.to + 1;
  }

  return {
    type,
    collapsibleMod,
    title,
    body: bodyLines.join("\n"),
    blockFrom,
    blockTo,
    firstLineFrom: firstLine.from,
    firstLineTo: firstLine.to,
  };
}

// ── Icons ──────────────────────────────────────────────────────────────────────

const ICONS: Record<CalloutType, string> = {
  note: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  info: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  tip: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 3.07-1.96 5.7-4.71 6.71L14 21H10l-.29-5.29C6.96 14.7 5 12.07 5 9a7 7 0 0 1 7-7z"/><line x1="10" y1="21" x2="14" y2="21"/></svg>`,
  success: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  question: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  warning: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  failure: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  danger: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  bug: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2"/><path d="M5 7l3 2"/><path d="M19 12h-4"/><path d="M5 12h4"/><path d="M19 17l-3-2"/><path d="M5 17l3-2"/><path d="M9 3l1.5 3h3L15 3"/></svg>`,
  example: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  quote: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>`,
  abstract: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>`,
  todo: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
};

// ── Collapsed state ────────────────────────────────────────────────────────────

// Keyed by blockFrom (document position of first char of blockquote).
// Resets when the document changes enough that blockFrom moves — acceptable trade-off.
const collapsedState: Map<number, boolean> = new Map();

export const toggleCalloutEffect = StateEffect.define<number>();

// ── Widgets ────────────────────────────────────────────────────────────────────

class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly calloutType: CalloutType,
    readonly title: string,
    readonly collapsibleMod: "+" | "-" | "",
    readonly blockFrom: number,
    readonly collapsed: boolean,
  ) {
    super();
  }

  eq(other: CalloutTitleWidget): boolean {
    return (
      this.calloutType === other.calloutType &&
      this.title === other.title &&
      this.collapsibleMod === other.collapsibleMod &&
      this.blockFrom === other.blockFrom &&
      this.collapsed === other.collapsed
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = `cm-callout-title-wrap`;

    const icon = document.createElement("span");
    icon.className = "cm-callout-icon";
    icon.innerHTML = ICONS[this.calloutType] ?? ICONS.note;
    wrap.appendChild(icon);

    const titleEl = document.createElement("span");
    titleEl.className = "cm-callout-title";
    titleEl.textContent = this.title;
    wrap.appendChild(titleEl);

    if (this.collapsibleMod !== "") {
      const chevron = document.createElement("span");
      chevron.className =
        "cm-callout-chevron" + (this.collapsed ? " cm-callout-chevron-collapsed" : "");
      chevron.setAttribute("data-callout-toggle", "true");
      chevron.setAttribute("data-callout-from", String(this.blockFrom));
      chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
      wrap.appendChild(chevron);
    }

    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── StateField ────────────────────────────────────────────────────────────────

function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const head = state.selection.main.head;

  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];

  // Pass 1: collect every Blockquote that parses as a callout. Nested
  // blockquotes are visited too, so `> > [!note]` becomes its own entry.
  const callouts: CalloutInfo[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Blockquote") return;
      const info = parseCallout(state, node.from, node.to);
      if (info) callouts.push(info);
    },
  });

  // Pass 2: render each callout, but skip lines that belong to a nested
  // callout so the inner one can render without the outer repainting over it.
  for (const info of callouts) {
    const innerRanges = callouts
      .filter(
        (other) =>
          other !== info &&
          other.blockFrom > info.blockFrom &&
          other.blockTo <= info.blockTo,
      )
      .map((o) => ({ from: o.blockFrom, to: o.blockTo }));

    const lineInInner = (line: { from: number; to: number }): boolean =>
      innerRanges.some((r) => line.from >= r.from && line.to <= r.to);

    const cursorInside = head >= info.blockFrom && head <= info.blockTo;

    const isCollapsible = info.collapsibleMod !== "";
    const defaultCollapsed = info.collapsibleMod === "-";
    const collapsed =
      isCollapsible &&
      (collapsedState.has(info.blockFrom)
        ? collapsedState.get(info.blockFrom)!
        : defaultCollapsed);

    if (cursorInside) {
      let lineStart = info.blockFrom;
      while (lineStart <= info.blockTo) {
        const line = doc.lineAt(lineStart);
        if (!lineInInner(line)) {
          ranges.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({
              class: `cm-callout cm-callout-${info.type}`,
            }),
          });
        }
        if (line.to >= info.blockTo) break;
        lineStart = line.to + 1;
      }
      continue;
    }

    // First line: line class + title widget (icon + title + optional chevron)
    const firstLine = doc.lineAt(info.blockFrom);
    ranges.push({
      from: firstLine.from,
      to: firstLine.from,
      decoration: Decoration.line({
        class: `cm-callout cm-callout-${info.type} cm-callout-title-line`,
      }),
    });
    ranges.push({
      from: firstLine.from,
      to: firstLine.to,
      decoration: Decoration.replace({
        widget: new CalloutTitleWidget(
          info.type,
          info.title,
          info.collapsibleMod,
          info.blockFrom,
          collapsed,
        ),
      }),
    });

    // Body lines
    if (firstLine.to < info.blockTo) {
      let lineStart = firstLine.to + 1;
      while (lineStart <= info.blockTo) {
        const line = doc.lineAt(lineStart);

        if (lineInInner(line)) {
          if (line.to >= info.blockTo) break;
          lineStart = line.to + 1;
          continue;
        }

        if (collapsed) {
          ranges.push({
            from: line.from,
            to: line.to < info.blockTo ? line.to + 1 : line.to,
            decoration: Decoration.replace({ block: true }),
          });
        } else {
          ranges.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({
              class: `cm-callout cm-callout-${info.type} cm-callout-body-line`,
            }),
          });

          const bqMatch = BQ_PREFIX_RE.exec(line.text);
          const hideLen = bqMatch?.[1]?.length ?? 0;
          if (hideLen > 0) {
            ranges.push({
              from: line.from,
              to: line.from + hideLen,
              decoration: Decoration.replace({}),
            });
          }
        }

        if (line.to >= info.blockTo) break;
        lineStart = line.to + 1;
      }
    }
  }

  // Sort: line decorations (from === to) before replace decorations, and by position
  ranges.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    // line decorations (zero-length) before replace decorations
    const aLen = a.to - a.from;
    const bLen = b.to - b.from;
    return aLen - bLen;
  });

  const set = Decoration.set(
    ranges.map((r) => r.decoration.range(r.from, r.to)),
    true, // sort by position
  );

  return set;
}

export const calloutField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection) {
      // Handle collapsed state updates
      for (const effect of tr.effects) {
        if (effect.is(toggleCalloutEffect)) {
          const pos = effect.value;
          const current = collapsedState.get(pos);
          // If not in map, default depends on what the callout's mod was.
          // We'll just toggle whatever is currently rendered.
          collapsedState.set(pos, !current);
        }
      }
      return buildDecorations(tr.state);
    }
    for (const effect of tr.effects) {
      if (effect.is(toggleCalloutEffect)) {
        const pos = effect.value;
        const current = collapsedState.get(pos);
        collapsedState.set(pos, !current);
        return buildDecorations(tr.state);
      }
    }
    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

// ── ViewPlugin for click handling ─────────────────────────────────────────────

import { ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";

export const calloutClickPlugin = ViewPlugin.fromClass(
  class {
    update(_update: ViewUpdate) {}
  },
  {
    eventHandlers: {
      mousedown(event: MouseEvent, view: EditorView) {
        const target = event.target as HTMLElement;
        const toggleEl = target.closest("[data-callout-toggle]");
        if (!toggleEl) return false;

        const fromAttr = toggleEl.getAttribute("data-callout-from");
        if (!fromAttr) return false;

        const blockFrom = parseInt(fromAttr, 10);
        if (isNaN(blockFrom)) return false;

        event.preventDefault();
        event.stopPropagation();

        view.dispatch({
          effects: [toggleCalloutEffect.of(blockFrom)],
        });

        return true;
      },
    },
  },
);

// ── Exported extension ────────────────────────────────────────────────────────

import type { Extension } from "@codemirror/state";

export const calloutPlugin: Extension = [calloutField, calloutClickPlugin];
