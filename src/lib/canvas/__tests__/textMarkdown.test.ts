// #364 — computeCanvasTextHtml builds the mdTextNodes map fed to
// CanvasRenderer. Smoke-level tests: it renders every text node,
// skips the editing one, and ignores non-text nodes.

import { describe, it, expect } from "vitest";
import { computeCanvasTextHtml } from "../textMarkdown";
import type { CanvasDoc } from "../types";

function doc(nodes: CanvasDoc["nodes"]): CanvasDoc {
  return { nodes, edges: [], extra: {} };
}

describe("computeCanvasTextHtml (#364)", () => {
  it("renders markdown for every text node", () => {
    const d = doc([
      { id: "a", type: "text", text: "**bold**", x: 0, y: 0, width: 120, height: 40 },
      { id: "b", type: "text", text: "# heading", x: 0, y: 60, width: 120, height: 40 },
    ]);
    const out = computeCanvasTextHtml(d);
    expect(out.a).toContain("<strong>bold</strong>");
    expect(out.b).toContain("<h1");
  });

  it("skips the node id passed as skipId", () => {
    const d = doc([
      { id: "a", type: "text", text: "a", x: 0, y: 0, width: 120, height: 40 },
      { id: "b", type: "text", text: "b", x: 0, y: 60, width: 120, height: 40 },
    ]);
    const out = computeCanvasTextHtml(d, "a");
    expect(out.a).toBeUndefined();
    expect(out.b).toBeDefined();
  });

  it("ignores non-text nodes", () => {
    const d = doc([
      { id: "f", type: "file", file: "x.md", x: 0, y: 0, width: 120, height: 40 },
      { id: "l", type: "link", url: "https://x", x: 0, y: 60, width: 120, height: 40 },
      { id: "g", type: "group", x: 0, y: 120, width: 300, height: 200 },
      { id: "t", type: "text", text: "ok", x: 0, y: 400, width: 120, height: 40 },
    ]);
    const out = computeCanvasTextHtml(d);
    expect(Object.keys(out)).toEqual(["t"]);
  });

  it("handles empty text gracefully", () => {
    const d = doc([
      { id: "t", type: "text", text: "", x: 0, y: 0, width: 120, height: 40 },
    ]);
    const out = computeCanvasTextHtml(d);
    expect(out.t).toBe("");
  });

  it("passes noteTitle through to renderMarkdownToHtml for {{title}} binding", () => {
    const d = doc([
      { id: "t", type: "text", text: "{{title}}", x: 0, y: 0, width: 120, height: 40 },
    ]);
    const out = computeCanvasTextHtml(d, null, "MyCanvas");
    expect(out.t).toContain("MyCanvas");
  });

  it("emits data-wiki-target for [[link]] so the renderer can delegate clicks", () => {
    const d = doc([
      { id: "t", type: "text", text: "see [[Welcome]]", x: 0, y: 0, width: 120, height: 40 },
    ]);
    const out = computeCanvasTextHtml(d);
    expect(out.t).toContain('data-wiki-target="Welcome"');
  });
});
