// Regression tests for issue #247:
// Three CodeMirror plugin paths used to serialise the entire document via
// `doc.toString()` on every keystroke — directly eating the 16 ms keystroke
// budget on long notes:
//
//   1. livePreview.ts buildDecorations — `detectFrontmatter(doc.toString())`
//      on every docChanged / viewportChanged / selectionSet transaction.
//   2. frontmatterPlugin.ts buildDecorations (StateField) — same pattern on
//      every tr.docChanged.
//   3. frontmatterPlugin.ts frontmatterBoundaryGuard (transactionFilter) —
//      same pattern on every *input* transaction; stacks with (2).
//
// The fix reads only the head of the document (FRONTMATTER_MAX_SLICE bytes)
// via `doc.sliceString(0, FRONTMATTER_MAX_SLICE)`. Frontmatter is either at
// offset 0 or absent, and never grows past a few hundred bytes in practice,
// so a 16 KB head slice is a strict superset of any legitimate frontmatter.
//
// The tests below assert:
//   - `Text.prototype.toString` is NEVER called on the three hot paths.
//   - Decoration output is unchanged for realistic inputs (parity).
//   - The StateField still rebuilds on docChanged.
//   - The boundary guard still rewrites inserts into the frontmatter region.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState, EditorSelection, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

import { frontmatterPlugin } from "../frontmatterPlugin";
import { livePreviewPlugin } from "../livePreview";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ extensions: [GFM] }),
      frontmatterPlugin,
      livePreviewPlugin,
    ],
  });
}

function mountView(doc: string): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: makeState(doc),
    parent,
  });
  return { view, parent };
}

// ─── hot-path toString assertion ────────────────────────────────────────────

describe("CM6 frontmatter plugins — no doc.toString() on keystroke (issue #247)", () => {
  let toStringSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    toStringSpy = vi.spyOn(Text.prototype, "toString");
  });

  afterEach(() => {
    toStringSpy.mockRestore();
  });

  it("does not call Text.toString() on a typing transaction (frontmatter StateField + boundary guard)", () => {
    // Long body so any full-doc toString() would clearly show up in the spy.
    const longBody = "word ".repeat(10_000).trim();
    const doc = `---\ntitle: Hello\n---\n${longBody}`;
    const { view, parent } = mountView(doc);

    toStringSpy.mockClear();

    // Dispatch a body-side insertion — passes through the boundary guard and
    // triggers the StateField update because docChanged is true.
    view.dispatch({
      changes: { from: view.state.doc.length, to: view.state.doc.length, insert: "x" },
      userEvent: "input.type",
    });

    expect(toStringSpy).not.toHaveBeenCalled();

    view.destroy();
    parent.remove();
  });

  it("does not call Text.toString() on a selection-only transaction (livePreview rebuild path)", () => {
    // livePreview rebuilds on selectionSet; pre-fix it would call
    // detectFrontmatter(doc.toString()) on every arrow-key tap.
    const longBody = "word ".repeat(10_000).trim();
    const doc = `---\ntitle: Hello\n---\n${longBody}`;
    const { view, parent } = mountView(doc);

    toStringSpy.mockClear();

    // 5 simulated arrow-key cursor moves in the body.
    for (let i = 30; i <= 34; i++) {
      view.dispatch({ selection: EditorSelection.cursor(i) });
    }

    expect(toStringSpy).not.toHaveBeenCalled();

    view.destroy();
    parent.remove();
  });

  it("does not call Text.toString() on an input transaction with no frontmatter", () => {
    // The boundary guard short-circuits when no frontmatter is present, but
    // pre-fix it still serialised the doc once to make that determination.
    const longBody = "word ".repeat(10_000).trim();
    const { view, parent } = mountView(longBody);

    toStringSpy.mockClear();

    view.dispatch({
      changes: { from: view.state.doc.length, to: view.state.doc.length, insert: "x" },
      userEvent: "input.type",
    });

    expect(toStringSpy).not.toHaveBeenCalled();

    view.destroy();
    parent.remove();
  });
});

// ─── parity: frontmatter StateField still rebuilds on docChanged ────────────

function collectBlockRanges(view: EditorView): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  // EditorView aggregates decoration facet entries; iterate the resolved set.
  const state = view.state;
  const facetValues = state.facet(EditorView.decorations);
  for (const entry of facetValues) {
    const set: DecorationSet =
      typeof entry === "function" ? (entry as (v: EditorView) => DecorationSet)(view) : entry;
    if (!set) continue;
    set.between(0, state.doc.length, (from, to, deco) => {
      if ((deco.spec as { block?: boolean }).block === true) {
        ranges.push({ from, to });
      }
    });
  }
  return ranges;
}

describe("frontmatterPlugin StateField — parity (issue #247)", () => {
  it("hides the frontmatter block with a single block-replace decoration", () => {
    const doc = "---\ntitle: Test\n---\n# Body\n";
    const { view, parent } = mountView(doc);

    const blocks = collectBlockRanges(view);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.from).toBe(0);
    expect(blocks[0]!.to).toBe("---\ntitle: Test\n---\n".length);

    view.destroy();
    parent.remove();
  });

  it("rebuilds the block decoration when the frontmatter region grows", () => {
    const doc = "---\ntitle: A\n---\n# Body\n";
    const { view, parent } = mountView(doc);

    const before = collectBlockRanges(view);
    expect(before).toHaveLength(1);

    // Insert a new key inside the frontmatter body (before the closing ---).
    const closingFenceStart = "---\ntitle: A\n".length;
    view.dispatch({
      changes: { from: closingFenceStart, insert: "tags: [x]\n" },
    });

    const after = collectBlockRanges(view);
    expect(after).toHaveLength(1);
    expect(after[0]!.to).toBeGreaterThan(before[0]!.to);

    view.destroy();
    parent.remove();
  });

  it("produces no frontmatter block decoration when there is no frontmatter", () => {
    const doc = "# Plain body\n";
    const { view, parent } = mountView(doc);

    expect(collectBlockRanges(view)).toHaveLength(0);

    view.destroy();
    parent.remove();
  });
});

// ─── parity: boundary guard still rewrites ──────────────────────────────────

describe("frontmatterBoundaryGuard — parity (issue #247)", () => {
  it("redirects a Cmd-A + type replacement past the frontmatter block", () => {
    const doc = "---\ntitle: Test\n---\n# Body\nHello\nWorld\n";
    const { view, parent } = mountView(doc);

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "X" },
      userEvent: "input.type",
    });

    // The boundary guard must keep the frontmatter intact and append "X"
    // immediately after it.
    expect(view.state.doc.sliceString(0, view.state.doc.length)).toBe(
      "---\ntitle: Test\n---\nX",
    );

    view.destroy();
    parent.remove();
  });

  it("passes body-only edits through unchanged", () => {
    const doc = "---\ntitle: T\n---\nAlpha\n";
    const { view, parent } = mountView(doc);
    const alphaStart = doc.indexOf("Alpha");

    view.dispatch({
      changes: { from: alphaStart, to: alphaStart + 5, insert: "Gamma" },
      userEvent: "input.type",
    });

    expect(view.state.doc.sliceString(0, view.state.doc.length)).toBe(
      "---\ntitle: T\n---\nGamma\n",
    );

    view.destroy();
    parent.remove();
  });

  it("does not intervene for non-input userEvents", () => {
    const doc = "---\ntitle: T\n---\n# Body\n";
    const { view, parent } = mountView(doc);

    view.dispatch({
      changes: { from: 0, to: 4 },
      userEvent: "delete.line",
    });

    // First `---\n` was removed — guard does not rewrite non-input events.
    expect(view.state.doc.sliceString(0, view.state.doc.length)).toBe(
      "title: T\n---\n# Body\n",
    );

    view.destroy();
    parent.remove();
  });

  it("handles a transaction with a very long body without serialising the doc", () => {
    // Long body plus an input transaction that touches the head of the doc.
    // Pre-fix this called detectFrontmatter on tr.startState.doc.toString()
    // — now bounded to the first 16 KB.
    const longBody = "word ".repeat(20_000).trim();
    const doc = `---\ntitle: Long\n---\n${longBody}`;
    const { view, parent } = mountView(doc);

    const toStringSpy = vi.spyOn(Text.prototype, "toString");

    view.dispatch({
      changes: { from: 0, to: 0, insert: "X" },
      userEvent: "input.type",
    });

    // Guard redirects the insert past the frontmatter region; body stays
    // intact, frontmatter stays intact.
    expect(view.state.doc.sliceString(0, 20)).toBe("---\ntitle: Long\n---\n");
    // The 21st character (first char of body after the redirect) is "X".
    expect(view.state.doc.sliceString(20, 21)).toBe("X");

    expect(toStringSpy).not.toHaveBeenCalled();

    toStringSpy.mockRestore();
    view.destroy();
    parent.remove();
  });
});

// ─── livePreview parity ─────────────────────────────────────────────────────

describe("livePreview — frontmatter header-mark suppression (issue #247)", () => {
  it("does not hide header marks inside the frontmatter region", () => {
    // Frontmatter closing fence `---` parses as HeaderMark (setext H2). The
    // livePreview plugin must skip hiding HeaderMarks that fall inside the
    // frontmatter region — the previous detectFrontmatter(doc.toString())
    // was load-bearing for this check and the sliced variant must stay
    // behaviourally identical.
    const doc = "---\ntitle: T\n---\n# Heading\n";
    const { view, parent } = mountView(doc);

    // Park the cursor outside the heading line so livePreview would hide
    // marks. The frontmatter closing `---` lives on line 3; the heading
    // `#` lives on line 4. Cursor on line 1 (char 0) means both are
    // off-cursor; only the body `#` must get a hide decoration, not the
    // frontmatter `---`.
    view.dispatch({ selection: EditorSelection.cursor(0) });

    const plugin = view.plugin(livePreviewPlugin);
    expect(plugin).not.toBeNull();
    const decos = plugin!.decorations;

    // Collect hide-decoration ranges.
    const hidden: Array<{ from: number; to: number }> = [];
    decos.between(0, view.state.doc.length, (from, to) => {
      hidden.push({ from, to });
    });

    // Frontmatter region is [0, 20) (`---\ntitle: T\n---\n`, 20 chars).
    // No hide range may overlap [0, 20).
    const frontmatterEnd = "---\ntitle: T\n---\n".length;
    for (const r of hidden) {
      // Non-overlap condition: r.from >= frontmatterEnd OR r.to <= 0.
      const nonOverlap = r.from >= frontmatterEnd || r.to <= 0;
      expect(nonOverlap).toBe(true);
    }

    // The body `#` on line 4 should be hidden (it's outside the frontmatter
    // and off-cursor).
    const headingHashPos = doc.indexOf("# Heading");
    expect(
      hidden.some((r) => r.from === headingHashPos && r.to >= headingHashPos + 1),
    ).toBe(true);

    view.destroy();
    parent.remove();
  });

  it("hides all off-cursor HeaderMarks when no frontmatter is present", () => {
    const doc = "# First\n\n## Second\n\nbody\n";
    const { view, parent } = mountView(doc);

    // Cursor on line 5 (body) — both headings are off-cursor.
    const bodyPos = doc.indexOf("body");
    view.dispatch({ selection: EditorSelection.cursor(bodyPos) });

    const plugin = view.plugin(livePreviewPlugin);
    const decos = plugin!.decorations;

    const hidden: Array<{ from: number; to: number }> = [];
    decos.between(0, view.state.doc.length, (from, to) => {
      hidden.push({ from, to });
    });

    // Both `#` and `##` must have hide ranges.
    const firstHashPos = doc.indexOf("# First");
    const secondHashPos = doc.indexOf("## Second");
    expect(hidden.some((r) => r.from === firstHashPos)).toBe(true);
    expect(hidden.some((r) => r.from === secondHashPos)).toBe(true);

    view.destroy();
    parent.remove();
  });
});

