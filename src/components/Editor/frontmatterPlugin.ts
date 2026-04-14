import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, StateField, Transaction } from "@codemirror/state";
import type { ChangeSpec, Extension } from "@codemirror/state";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/;

export interface FrontmatterRegion {
  from: number;
  to: number;
  body: string;
}

export function detectFrontmatter(docText: string): FrontmatterRegion | null {
  const match = FRONTMATTER_RE.exec(docText);
  if (!match) return null;
  return { from: 0, to: match[0].length, body: match[1] ?? "" };
}

// Empty block widget. The frontmatter region is fully hidden — properties
// are edited in the RightSidebar's Properties panel, not inline. Block
// replace decorations are atomic, so the cursor can never enter the region.
class EmptyBlockWidget extends WidgetType {
  eq(_other: EmptyBlockWidget): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-frontmatter-hidden";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const HIDDEN_WIDGET = new EmptyBlockWidget();

function buildDecorations(state: EditorState): DecorationSet {
  const region = detectFrontmatter(state.doc.toString());
  if (!region) return Decoration.none;

  return Decoration.set([
    Decoration.replace({
      widget: HIDDEN_WIDGET,
      block: true,
    }).range(region.from, region.to),
  ]);
}

// Block-level replace decorations MUST be provided through the
// EditorView.decorations facet (via a StateField), not through
// ViewPlugin's `decorations` option — the latter silently ignores
// block decorations.
const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

// When the body is empty, the editor cursor sits at position 0 — before the
// block-replace decoration — and typing inserts a character ahead of the
// opening `---`, which breaks frontmatter detection and exposes the raw YAML.
// Redirect user-input insertions that land at or inside the frontmatter region
// to the first body position instead.
const frontmatterBoundaryGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  if (!userEvent || !userEvent.startsWith("input")) return tr;

  const region = detectFrontmatter(tr.startState.doc.toString());
  if (!region) return tr;

  const rewrites: ChangeSpec[] = [];
  let insertedAtBoundary = 0;
  let redirected = false;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA < region.to && inserted.length > 0) {
      rewrites.push({ from: region.to, to: region.to, insert: inserted.toString() });
      insertedAtBoundary += inserted.length;
      redirected = true;
    } else {
      rewrites.push({ from: fromA, to: toA, insert: inserted.toString() });
    }
  });

  if (!redirected) return tr;

  return {
    changes: rewrites,
    selection: { anchor: region.to + insertedAtBoundary },
    sequential: true,
  };
});

export const frontmatterPlugin: Extension = [frontmatterField, frontmatterBoundaryGuard];
