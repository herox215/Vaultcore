import { describe, it, expect, beforeEach, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import DOMPurify from "dompurify";
import {
  sanitizeHtml,
  __resetSanitizeCacheForTests,
  __test,
} from "../inlineHtml";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ extensions: [GFM] }),
      __test.viewportField,
      __test.inlineHtmlField,
    ],
  });
}

/** Count the decoration ranges contained in a DecorationSet. */
function decorationCount(state: EditorState): number {
  const set = state.field(__test.inlineHtmlField).decorations;
  let n = 0;
  set.between(0, state.doc.length, () => {
    n += 1;
  });
  return n;
}

describe("inlineHtml — sanitizer", () => {
  it("strips <script> tags", () => {
    expect(sanitizeHtml('<script>alert("xss")</script>')).toBe("");
  });

  it("strips onclick attributes", () => {
    const result = sanitizeHtml('<div onclick="alert(1)">text</div>');
    expect(result).not.toContain("onclick");
    expect(result).toContain("text");
  });

  it("strips onerror attributes", () => {
    const result = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(result).not.toContain("onerror");
  });

  it("strips javascript: URLs from href", () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain("javascript:");
  });

  it("strips <iframe> tags", () => {
    expect(sanitizeHtml('<iframe src="https://evil.com"></iframe>')).toBe("");
  });

  it("strips <foreignObject> from SVG", () => {
    const result = sanitizeHtml(
      '<svg><foreignObject><div onclick="alert(1)">x</div></foreignObject></svg>',
    );
    expect(result).not.toContain("foreignObject");
  });

  it("strips <object> and <embed> tags", () => {
    expect(sanitizeHtml('<object data="evil.swf"></object>')).toBe("");
    expect(sanitizeHtml('<embed src="evil.swf">')).toBe("");
  });

  // ── Allowed tags ────────────────────────────────────────────────────────────

  it("renders <div> with content", () => {
    const result = sanitizeHtml("<div>hello</div>");
    expect(result).toBe("<div>hello</div>");
  });

  it("renders <span> with style", () => {
    const result = sanitizeHtml('<span style="color: red">red text</span>');
    expect(result).toContain("color: red");
    expect(result).toContain("red text");
  });

  it("renders <details>/<summary>", () => {
    const result = sanitizeHtml(
      "<details><summary>Title</summary><p>Content</p></details>",
    );
    expect(result).toContain("<details>");
    expect(result).toContain("<summary>");
    expect(result).toContain("Title");
    expect(result).toContain("Content");
  });

  it("renders <kbd>", () => {
    const result = sanitizeHtml("<kbd>Ctrl</kbd>+<kbd>C</kbd>");
    expect(result).toContain("<kbd>");
    expect(result).toContain("Ctrl");
  });

  it("renders <sub> and <sup>", () => {
    expect(sanitizeHtml("H<sub>2</sub>O")).toContain("<sub>2</sub>");
    expect(sanitizeHtml("x<sup>2</sup>")).toContain("<sup>2</sup>");
  });

  it("renders <mark>", () => {
    const result = sanitizeHtml("<mark>highlighted</mark>");
    expect(result).toContain("<mark>");
    expect(result).toContain("highlighted");
  });

  it("renders <br> and <hr>", () => {
    expect(sanitizeHtml("line<br>break")).toContain("<br>");
    expect(sanitizeHtml("<hr>")).toContain("<hr>");
  });

  it("renders <center>", () => {
    const result = sanitizeHtml("<center>centered</center>");
    expect(result).toContain("centered");
  });

  it("renders inline SVG", () => {
    const svg = '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10"/></svg>';
    const result = sanitizeHtml(svg);
    expect(result).toContain("<svg");
    expect(result).toContain("<circle");
    expect(result).toContain('r="10"');
  });

  it("preserves class and id attributes", () => {
    const result = sanitizeHtml('<div class="note" id="intro">text</div>');
    expect(result).toContain('class="note"');
    expect(result).toContain('id="intro"');
  });

  // ── Comments ────────────────────────────────────────────────────────────────

  it("strips HTML comments (DOMPurify removes them)", () => {
    const result = sanitizeHtml("<!-- this is a comment -->");
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("this is a comment");
  });
});

// ── Performance: decoration rebuild short-circuits (#249) ────────────────────

describe("inlineHtml — rebuild short-circuits (#249)", () => {
  beforeEach(() => {
    __resetSanitizeCacheForTests();
  });

  it("does NOT call DOMPurify.sanitize on a selection-only transaction that stays outside any HTML node", () => {
    const doc = [
      "Plain paragraph line one.",
      "",
      "<details><summary>s</summary>b</details>",
      "",
      "Another paragraph.",
      "One more line here.",
    ].join("\n");

    // Start with cursor on line 1 (outside the HTML block), which forces
    // the initial build + cache fill.
    const initial = makeState(doc).update({
      selection: EditorSelection.cursor(0),
    }).state;

    // Prime the sanitize cache via the initial build.
    initial.field(__test.inlineHtmlField);

    const spy = vi.spyOn(DOMPurify, "sanitize");
    spy.mockClear();

    // Move the cursor from line 1 start to line 1 end — still no HTML
    // boundary crossing. This must NOT trigger a rebuild nor any sanitize
    // call.
    const firstLine = initial.doc.line(1);
    const nextState = initial.update({
      selection: EditorSelection.cursor(firstLine.to),
    }).state;

    // Force value materialisation.
    const after = nextState.field(__test.inlineHtmlField);
    const before = initial.field(__test.inlineHtmlField);
    expect(after).toBe(before);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reuses the sanitize cache across rebuilds — same raw text sanitised at most once", () => {
    // Cursor defaults to 0 (line 1). Keep line 1 as a plain paragraph so the
    // HTML block is off-cursor and the initial build primes the cache.
    const doc = "paragraph before\n\n<details><summary>s</summary>body</details>\n";
    const state = makeState(doc);

    // Force the initial build so the raw html is in the cache.
    state.field(__test.inlineHtmlField);

    const spy = vi.spyOn(DOMPurify, "sanitize");
    spy.mockClear();

    // Call the public sanitizeHtml API with the same raw text — must be
    // served from the cache.
    const out = sanitizeHtml("<details><summary>s</summary>body</details>");
    expect(out).toContain("<details>");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rebuilds decorations when a doc change adds a new HTML block", () => {
    const doc = "paragraph one\n\nparagraph two\n";
    const s0 = makeState(doc);

    // Cursor off-line to allow potential widgets to render.
    const s1 = s0.update({ selection: EditorSelection.cursor(0) }).state;
    const before = decorationCount(s1);
    expect(before).toBe(0);

    const insertion = "\n\n<kbd>Ctrl</kbd>";
    const s2 = s1.update({
      changes: { from: s1.doc.length, insert: insertion },
    }).state;

    const after = decorationCount(s2);
    expect(after).toBeGreaterThan(before);
  });

  it("rebuilds when the cursor crosses into / out of an HTML block line", () => {
    const doc = [
      "paragraph one",
      "",
      "<details><summary>s</summary>body</details>",
      "",
      "paragraph two",
    ].join("\n");
    const s0 = makeState(doc);
    const outside = s0.doc.line(1).from; // line 1, outside the block
    const insideLine = s0.doc.line(3);   // the HTML line itself
    const inside = insideLine.from + 2;

    const sOutside = s0.update({ selection: EditorSelection.cursor(outside) }).state;
    const decoOutside = decorationCount(sOutside);

    const sInside = sOutside.update({ selection: EditorSelection.cursor(inside) }).state;
    const decoInside = decorationCount(sInside);

    // Moving the cursor onto the HTML line must hide the widget (no
    // replace decoration for that block), so the decoration count must
    // strictly decrease.
    expect(decoInside).toBeLessThan(decoOutside);
  });

  it("returns the same value reference when selection moves within a plain region", () => {
    const doc = "line one here\nline two here\nline three here\n";
    const s0 = makeState(doc);
    const a = s0.update({ selection: EditorSelection.cursor(0) }).state;
    const b = a.update({ selection: EditorSelection.cursor(4) }).state;
    expect(b.field(__test.inlineHtmlField)).toBe(a.field(__test.inlineHtmlField));
  });
});

// ── Performance: viewport clipping (#249) ────────────────────────────────────

describe("inlineHtml — viewport clipping (#249)", () => {
  beforeEach(() => {
    __resetSanitizeCacheForTests();
  });

  it("only processes HTML blocks inside the active viewport", () => {
    // Construct a very tall document with an HTML block near the top and
    // another near the bottom. With a narrow viewport around the top, only
    // the top block's sanitise should run.
    const top = "<details><summary>TOP</summary>top body</details>";
    const bottom = "<details><summary>BOTTOM</summary>bottom body</details>";
    const filler = Array.from({ length: 2_000 }, (_, i) => `filler line ${i}`).join(
      "\n",
    );
    const doc = `leading paragraph\n\n${top}\n\n${filler}\n\n${bottom}\n`;

    const s0 = makeState(doc);
    // Set viewport to the top slice — must cover the `top` block (starts on
    // line 3) but stop before the filler/bottom block.
    const topBlockEnd = s0.doc.line(3).to + 1;
    const s1 = s0.update({
      effects: __test.setViewportEffect.of({ from: 0, to: topBlockEnd }),
    }).state;
    // Materialise so s1's build runs under the new viewport.
    s1.field(__test.inlineHtmlField);

    __resetSanitizeCacheForTests();
    const spy = vi.spyOn(DOMPurify, "sanitize");
    spy.mockClear();

    // Move cursor off line 1, forcing a rebuild whose iterate() stays
    // clipped to the configured viewport.
    const sCursor = s1.update({
      selection: EditorSelection.cursor(s1.doc.line(1).to),
    }).state;
    const value = sCursor.field(__test.inlineHtmlField);

    // The top block must be enumerated; the bottom block must not have been
    // touched — iterate was clipped to the viewport.
    const nodeTexts = value.ranges.map((r) =>
      sCursor.doc.sliceString(r.from, r.to),
    );
    expect(nodeTexts.some((t) => t.includes("TOP"))).toBe(true);
    expect(nodeTexts.some((t) => t.includes("BOTTOM"))).toBe(false);

    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("BOTTOM"))).toBe(false);
    spy.mockRestore();
  });
});

