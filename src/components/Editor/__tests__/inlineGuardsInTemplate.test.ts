// Integration test (#295): wikiLinkPlugin must not decorate `[[...]]` that
// occurs inside a `{{ ... }}` template expression body.
//
// This is the user-reported regression — `{{ ... select(n => "- [[" + n.title
// + "]]").join("\n") }}` was triggering the wiki-link live preview on the
// literal brackets inside the expression source.
//
// We mount a real CodeMirror EditorView with only `wikiLinkPlugin` and read
// the decoration set directly. No markdown language extension is installed,
// so `isInsideCodeBlock` sees only a trivial syntax tree (always returns
// false) — exactly the case we want the new guard to catch.

import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";

import { wikiLinkPlugin, setResolvedLinks } from "../wikiLink";

function mount(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [wikiLinkPlugin],
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}

// Count decoration spans the plugin installed in `[from, to)`.
function decoCountInRange(view: EditorView, from: number, to: number): number {
  let count = 0;
  for (const plugin of (view as unknown as {
    plugins: Array<{ value?: { decorations?: unknown } }>;
  }).plugins) {
    const deco = plugin.value?.decorations;
    if (!deco) continue;
    const set = deco as ReturnType<typeof Decoration.none.update>;
    const iter = set.iter();
    while (iter.value) {
      if (iter.from >= from && iter.to <= to) count++;
      iter.next();
    }
  }
  return count;
}

describe("wikiLinkPlugin — respects {{ ... }} template ranges (#295)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // Seed a single resolvable target so wiki-link decorations WOULD normally
    // fire on `[[Alpha]]`; this is how we prove the guard is what's
    // suppressing them inside the expression body.
    setResolvedLinks(new Map([["alpha", "Alpha.md"]]));
  });

  it("decorates a plain [[Alpha]] outside any template expression", () => {
    const doc = "See [[Alpha]] for details.";
    const view = mount(doc, 0);
    // Cursor away from the link range → the plugin emits HIDE + mark spans.
    const linkFrom = doc.indexOf("[[Alpha]]");
    const linkTo = linkFrom + "[[Alpha]]".length;
    expect(decoCountInRange(view, linkFrom, linkTo)).toBeGreaterThan(0);
  });

  it("does NOT decorate [[Alpha]] that appears inside a {{ ... }} body", () => {
    const doc = 'pre {{vault.notes.select(n => "[[Alpha]]").join("\\n")}} post';
    const view = mount(doc, 0);

    const exprFrom = doc.indexOf("{{");
    const exprTo = doc.indexOf("}}") + 2;
    // No wiki-link decoration may appear anywhere inside the expression span.
    expect(decoCountInRange(view, exprFrom, exprTo)).toBe(0);
  });

  it("still decorates [[Alpha]] outside the expression even when another [[...]] sits inside", () => {
    // Same literal-in-expression case, but an independent real wiki-link
    // exists after it. The guard must only suppress the in-expression one.
    const doc = 'x {{select(n => "[[Alpha]]")}} and then [[Alpha]] for real';
    const view = mount(doc, 0);

    const realLinkFrom = doc.lastIndexOf("[[Alpha]]");
    const realLinkTo = realLinkFrom + "[[Alpha]]".length;
    expect(decoCountInRange(view, realLinkFrom, realLinkTo)).toBeGreaterThan(0);

    const exprFrom = doc.indexOf("{{");
    const exprTo = doc.indexOf("}}") + 2;
    expect(decoCountInRange(view, exprFrom, exprTo)).toBe(0);
  });
});
