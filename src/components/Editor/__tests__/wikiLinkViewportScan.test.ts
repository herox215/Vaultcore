// Regression tests for issue #247 (viewport-bounded scan in wikiLinkPlugin).
//
// Before the fix, `buildDecorations` called `view.state.doc.toString()` and
// ran the wiki-link regex over the ENTIRE document on every docChanged /
// viewportChanged / selectionSet transaction. On a 50k-char doc that allocates
// a full-doc string and burns the 16ms keystroke budget.
//
// The fix slices only `view.viewport.from..view.viewport.to` (with a 512-byte
// widen margin on each side so wiki-links and `{{ ... }}` template bodies that
// straddle the viewport boundary still get detected) and offsets every
// absolute position by the widened-window `from`.
//
// These tests lock in the viewport-bounded behaviour by overriding
// `view.viewport` on a jsdom-mounted EditorView (jsdom has no layout so the
// default viewport covers the whole doc, which would hide the regression).

import { describe, it, expect, beforeEach } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";

import { wikiLinkPlugin, setResolvedLinks } from "../wikiLink";

function mount(doc: string, cursor = 0): { view: EditorView; parent: HTMLElement } {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [wikiLinkPlugin],
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ state, parent });
  return { view, parent };
}

function overrideViewport(view: EditorView, from: number, to: number): void {
  Object.defineProperty(view, "viewport", {
    value: { from, to },
    configurable: true,
  });
}

interface Deco {
  from: number;
  to: number;
}

function collectDecos(view: EditorView): Deco[] {
  const out: Deco[] = [];
  for (const plugin of (view as unknown as {
    plugins: Array<{ value?: { decorations?: unknown } }>;
  }).plugins) {
    const deco = plugin.value?.decorations;
    if (!deco) continue;
    const set = deco as ReturnType<typeof Decoration.none.update>;
    const iter = set.iter();
    while (iter.value) {
      out.push({ from: iter.from, to: iter.to });
      iter.next();
    }
  }
  return out;
}

describe("wikiLinkPlugin — viewport-bounded scan (#247)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setResolvedLinks(new Map([["foo", "Foo.md"]]));
  });

  it("decorates a wiki-link inside the viewport at the correct absolute offset", () => {
    // 50k-char doc. A `[[foo]]` lives well inside the viewport window.
    const prefix = "a".repeat(1_000);
    const link = "[[foo]]";
    const suffix = "b".repeat(50_000);
    const doc = prefix + link + suffix;
    const linkFrom = prefix.length;
    const linkTo = linkFrom + link.length;

    const { view, parent } = mount(doc, 0);
    // Viewport covers the link. Cursor is at 0 so the link is off-cursor and
    // the plugin installs its HIDE + mark decorations.
    overrideViewport(view, 0, 5_000);
    // Trigger a rebuild under the restricted viewport.
    view.dispatch({ selection: EditorSelection.cursor(0) });

    const decos = collectDecos(view);
    // At least one decoration must land inside the link range.
    const inLink = decos.filter((d) => d.from >= linkFrom && d.to <= linkTo);
    expect(inLink.length).toBeGreaterThan(0);
    // Proves absolute-offset math: no decoration should have been placed
    // before the link at offset 0..linkFrom (no stray link in prefix).
    const beforeLink = decos.filter((d) => d.to <= linkFrom);
    expect(beforeLink).toEqual([]);

    view.destroy();
    parent.remove();
  });

  it("does NOT decorate wiki-links far outside the viewport + widen margin", () => {
    // This is the load-bearing regression test. On main the plugin scans the
    // full doc and decorates a `[[foo]]` at offset 30_000 even when the
    // viewport is [0, 1_000]. After the fix, the scan is bounded to
    // viewport ± 512 bytes, so a link at 30_000 must NOT be decorated.
    const filler = "x".repeat(30_000);
    const link = "[[foo]]";
    const tail = "y".repeat(10_000);
    const doc = filler + link + tail;
    const linkFrom = filler.length;
    const linkTo = linkFrom + link.length;

    const { view, parent } = mount(doc, 0);
    overrideViewport(view, 0, 1_000);
    view.dispatch({ selection: EditorSelection.cursor(500) });

    const decos = collectDecos(view);
    // No decoration may overlap the distant link range.
    const overlapping = decos.filter(
      (d) => d.to > linkFrom && d.from < linkTo,
    );
    expect(overlapping).toEqual([]);

    view.destroy();
    parent.remove();
  });

  it("still detects a wiki-link alias straddling the viewport start (widen margin works)", () => {
    // Place `[[foo|bar]]` so the opening `[[` is *before* the viewport start
    // but still within the 512-byte widen margin. The absolute-offset math
    // must place the decoration at the correct original-doc coordinates.
    const before = "p".repeat(2_000);
    const link = "[[foo|bar]]";
    const after = "s".repeat(3_000);
    const doc = before + link + after;
    const linkFrom = before.length;
    const linkTo = linkFrom + link.length;

    const { view, parent } = mount(doc, 0);
    // Put the viewport so it starts a few hundred bytes AFTER the link opens
    // but the widen margin (512) still reaches back to the `[[`.
    const viewportFrom = linkFrom + 4; // 4 bytes into the link → opening `[[` is viewportFrom-4, inside widen
    const viewportTo = viewportFrom + 1_000;
    overrideViewport(view, viewportFrom, viewportTo);
    view.dispatch({ selection: EditorSelection.cursor(viewportFrom + 100) });

    const decos = collectDecos(view);
    const overlapping = decos.filter(
      (d) => d.to > linkFrom && d.from < linkTo,
    );
    expect(overlapping.length).toBeGreaterThan(0);
    // Sanity: the overlapping decorations must sit inside the actual link
    // range — proves the baseOffset math is correct (not a doc-local slice
    // offset leaking through).
    for (const d of overlapping) {
      expect(d.from).toBeGreaterThanOrEqual(linkFrom);
      expect(d.to).toBeLessThanOrEqual(linkTo);
    }

    view.destroy();
    parent.remove();
  });

  it("excludes a [[...]] inside a {{ ... }} template even when the expression straddles the viewport", () => {
    // The `{{` opens before the viewport; the closing `}}` is inside it. The
    // wiki-link guard (isInsideTemplateExpr) must still recognise the range —
    // which means findTemplateExprRanges must be offset by the widened-window
    // `from`, not the slice-local 0.
    const lead = "z".repeat(2_000);
    const expr = '{{vault.notes.select(n => "[[foo]]").join("\\n")}}';
    const trail = "w".repeat(3_000);
    const doc = lead + expr + trail;

    const exprFrom = lead.length;
    const exprTo = exprFrom + expr.length;
    const innerLinkFrom = doc.indexOf("[[foo]]");
    const innerLinkTo = innerLinkFrom + "[[foo]]".length;

    const { view, parent } = mount(doc, 0);
    // Viewport starts INSIDE the expression body so `{{` is behind the
    // viewport.from. With a 512-byte widen, the `{{` at exprFrom (2_000) must
    // be recoverable when viewportFrom = 2_400 (margin 400 < 512).
    const viewportFrom = exprFrom + 400;
    const viewportTo = exprTo + 500;
    overrideViewport(view, viewportFrom, viewportTo);
    view.dispatch({ selection: EditorSelection.cursor(viewportFrom + 50) });

    const decos = collectDecos(view);
    // No wiki-link decoration may overlap the inner `[[foo]]` — it lives
    // inside the template body and the guard must exclude it.
    const overlapping = decos.filter(
      (d) => d.to > innerLinkFrom && d.from < innerLinkTo,
    );
    expect(overlapping).toEqual([]);

    view.destroy();
    parent.remove();
  });
});
