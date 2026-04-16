import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../inlineHtml";

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
