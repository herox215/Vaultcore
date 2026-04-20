import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, StateField, Transaction } from "@codemirror/state";
import type { ChangeSpec, Extension, Text } from "@codemirror/state";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/;

/**
 * #247 — head-slice cap for `detectFrontmatterInDoc`.
 *
 * Frontmatter lives at offset 0 or not at all, and in practice never grows
 * past a few hundred bytes; 16 KB is a comfortable upper bound that avoids
 * serialising the entire document on every keystroke/selection for the three
 * hot-path callers (livePreview decoration build, frontmatter StateField
 * rebuild, frontmatterBoundaryGuard transactionFilter). Before this cap,
 * each keystroke on a 10 k-word note paid two full-doc `toString()`
 * allocations, directly eating the 16 ms keystroke budget.
 */
const FRONTMATTER_MAX_SLICE = 16384;

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

/**
 * #247 — CM6 hot-path variant of `detectFrontmatter` that reads only the
 * first `FRONTMATTER_MAX_SLICE` bytes of the document via `doc.sliceString`,
 * avoiding the full-document `toString()` allocation on every keystroke.
 *
 * Safe because frontmatter is at offset 0 or absent, and is strictly bounded
 * by the closing `---` fence — either the head slice covers the entire
 * frontmatter region (overwhelmingly common: frontmatter is a few hundred
 * bytes at most) or the frontmatter is so pathologically large that
 * rendering would have other problems anyway. The spec promises a few
 * hundred bytes; the cap here is a 10x+ safety margin.
 */
export function detectFrontmatterInDoc(doc: Text): FrontmatterRegion | null {
  const headLen = Math.min(doc.length, FRONTMATTER_MAX_SLICE);
  if (headLen === 0) return null;
  const head = doc.sliceString(0, headLen);
  return detectFrontmatter(head);
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
  // #247 — head-slice variant avoids a full-doc toString() on every
  // docChanged transaction; frontmatter is bounded to a few hundred bytes
  // in practice, so the 16 KB head slice is a strict superset.
  const region = detectFrontmatterInDoc(state.doc);
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
// Redirect user-input insertions that touch the frontmatter region to the
// first body position instead, while preserving any body-portion deletion
// that was part of the same change (e.g. Cmd+A → type one char must still
// remove the body, not leave it intact with the new char prepended — issue #80).
const frontmatterBoundaryGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  if (!userEvent || !userEvent.startsWith("input")) return tr;

  // #247 — head-slice variant; the filter fires on every input transaction
  // and previously paid a full-doc toString() allocation every time.
  const region = detectFrontmatterInDoc(tr.startState.doc);
  if (!region) return tr;

  const rewrites: ChangeSpec[] = [];
  let redirected = false;
  let finalCursor = region.to;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const touchesFrontmatter = fromA < region.to;
    const hasInsert = inserted.length > 0;

    if (!touchesFrontmatter) {
      // Change lives entirely in the body — pass through unmodified.
      rewrites.push({ from: fromA, to: toA, insert: inserted.toString() });
      if (hasInsert) finalCursor = fromA + inserted.length;
      else finalCursor = fromA;
      return;
    }

    // Change touches (or is entirely inside) the frontmatter region.
    // Preserve the body-side portion of the deletion [region.to..toA) so
    // actions like Cmd+A → type one character still remove the original
    // body (issue #80: without this, the original body was left intact
    // and the inserted character appeared "before" it, making the doc
    // look like its content had been moved to the end).
    const bodyDeletionFrom = Math.max(fromA, region.to);
    const bodyDeletionTo = Math.max(toA, region.to);
    if (bodyDeletionFrom < bodyDeletionTo) {
      rewrites.push({ from: bodyDeletionFrom, to: bodyDeletionTo, insert: "" });
    }

    if (hasInsert) {
      rewrites.push({ from: region.to, to: region.to, insert: inserted.toString() });
      finalCursor = region.to + inserted.length;
      redirected = true;
    } else if (fromA < region.to && toA > region.to) {
      // Pure deletion spanning the boundary — cursor lands at region.to.
      finalCursor = region.to;
      redirected = true;
    } else if (fromA < region.to && toA <= region.to) {
      // Pure deletion entirely inside the frontmatter — drop it silently
      // (the filter's whole purpose is to keep the frontmatter intact).
      redirected = true;
    }
  });

  if (!redirected) return tr;

  return {
    changes: rewrites,
    selection: { anchor: finalCursor },
    sequential: true,
  };
});

export const frontmatterPlugin: Extension = [frontmatterField, frontmatterBoundaryGuard];
