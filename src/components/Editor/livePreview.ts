import { ViewPlugin, Decoration, type EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { detectFrontmatterInDoc } from "./frontmatterPlugin";

const HIDE = Decoration.replace({});

interface HideRange {
  from: number;
  to: number;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: HideRange[] = [];

  const head = view.state.selection.main.head;
  const cursorLine = view.state.doc.lineAt(head).number;
  const doc = view.state.doc;

  // Lezer parses `title: X\n---` as a setext H2, so the closing fence of a
  // YAML frontmatter block gets tagged as `HeaderMark`. Skip hiding inside
  // the frontmatter region — otherwise the closing `---` vanishes whenever
  // the cursor sits on a different line.
  //
  // #247 — read only the first ~16 KB of the doc via `sliceString` instead
  // of serialising the entire document; frontmatter is bounded to a few
  // hundred bytes in practice. Previously each selection-only arrow-key
  // transaction paid a full-doc `toString()` allocation here.
  const frontmatter = detectFrontmatterInDoc(doc);

  syntaxTree(view.state).iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter(node) {
      const name = node.name;

      if (name === "HeaderMark") {
        if (frontmatter && node.from >= frontmatter.from && node.to <= frontmatter.to) {
          return;
        }
        const nodeLine = doc.lineAt(node.from).number;
        if (cursorLine !== nodeLine) {
          let from = node.from;
          let to = node.to;
          if (to < doc.length && doc.sliceString(to, to + 1) === " ") {
            to += 1;
          }
          ranges.push({ from, to });
        }
      } else if (name === "EmphasisMark") {
        const parent = node.node.parent;
        if (parent && (parent.type.name === "Emphasis" || parent.type.name === "StrongEmphasis")) {
          if (head < parent.from || head > parent.to) {
            ranges.push({ from: node.from, to: node.to });
          }
        }
      } else if (name === "CodeMark") {
        const parent = node.node.parent;
        if (parent && parent.type.name === "InlineCode") {
          if (head < parent.from || head > parent.to) {
            ranges.push({ from: node.from, to: node.to });
          }
        }
      } else if (name === "StrikethroughMark") {
        const parent = node.node.parent;
        if (parent && parent.type.name === "Strikethrough") {
          if (head < parent.from || head > parent.to) {
            ranges.push({ from: node.from, to: node.to });
          }
        }
      }
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);

  for (const r of ranges) {
    builder.add(r.from, r.to, HIDE);
  }

  return builder.finish();
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
