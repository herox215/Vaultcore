// Unit tests for the canvas snapshot side of the tab-morph effect (#383).
// The DOM-side renderer is exercised via the EditorPane integration; the
// rules below have to be right regardless of how the renderer is wired.

import { describe, it, expect } from "vitest";
import { snapshotCanvas } from "../canvasTabMorph";
import type {
  CanvasDoc,
  CanvasFileNode,
  CanvasGroupNode,
  CanvasLinkNode,
  CanvasTextNode,
} from "../types";

function makeViewport(width = 800, height = 600): HTMLDivElement {
  const el = document.createElement("div");
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  // jsdom's getBoundingClientRect returns 0×0 for un-attached / un-styled
  // elements. Attach so the helper sees a real-ish rect; stub the call
  // because jsdom never lays things out.
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

function textNode(over: Partial<CanvasTextNode> = {}): CanvasTextNode {
  return {
    id: "n",
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    text: "",
    ...over,
  };
}

function emptyDoc(): CanvasDoc {
  return { nodes: [], edges: [] };
}

describe("snapshotCanvas", () => {
  it("returns null for an empty doc", () => {
    const el = makeViewport();
    expect(snapshotCanvas(el, emptyDoc(), 0, 0, 1)).toBeNull();
  });

  it("returns null when the viewport is not connected", () => {
    const el = document.createElement("div");
    expect(snapshotCanvas(el, emptyDoc(), 0, 0, 1)).toBeNull();
  });

  it("returns null for zoom <= 0 (defensive against pre-mount state)", () => {
    const el = makeViewport();
    const doc: CanvasDoc = { nodes: [textNode({ text: "x" })], edges: [] };
    expect(snapshotCanvas(el, doc, 0, 0, 0)).toBeNull();
    expect(snapshotCanvas(el, doc, 0, 0, -1)).toBeNull();
  });

  it("emits one glyph per character of a text node", () => {
    const el = makeViewport();
    const doc: CanvasDoc = {
      nodes: [textNode({ text: "abc", x: 0, y: 0, width: 200, height: 80 })],
      edges: [],
    };
    const snap = snapshotCanvas(el, doc, 0, 0, 1);
    expect(snap).not.toBeNull();
    expect(snap!.glyphs.map((g) => g.ch).join("")).toBe("abc");
  });

  it("places glyphs at projected viewport coords (camera transform applied)", () => {
    const el = makeViewport();
    const doc: CanvasDoc = {
      nodes: [textNode({ text: "ab", x: 100, y: 200, width: 300, height: 80 })],
      edges: [],
    };
    const snap = snapshotCanvas(el, doc, 10, 20, 2)!;
    // First glyph's x = node.x * zoom + camX = 100*2 + 10 = 210
    // First glyph's y = node.y * zoom + camY = 200*2 + 20 = 420
    expect(snap.glyphs[0]!.x).toBeCloseTo(210, 1);
    expect(snap.glyphs[0]!.y).toBeCloseTo(420, 1);
    // Second glyph is on the same line, one cell to the right.
    expect(snap.glyphs[1]!.x).toBeGreaterThan(snap.glyphs[0]!.x);
    expect(snap.glyphs[1]!.y).toBeCloseTo(snap.glyphs[0]!.y, 1);
  });

  it("culls nodes entirely off-screen so they don't burn glyph budget", () => {
    const el = makeViewport(800, 600);
    const doc: CanvasDoc = {
      nodes: [
        // Way to the right of the 800-px-wide viewport.
        textNode({ id: "off", text: "OFFSCREEN", x: 9999, y: 0 }),
        textNode({ id: "on", text: "X", x: 0, y: 0 }),
      ],
      edges: [],
    };
    const snap = snapshotCanvas(el, doc, 0, 0, 1)!;
    expect(snap.glyphs.map((g) => g.ch).join("")).toBe("X");
  });

  it("uses a file node's basename, not its full vault path", () => {
    const el = makeViewport();
    const fileNode: CanvasFileNode = {
      id: "f",
      type: "file",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      file: "folder/sub/notes.md",
    };
    const snap = snapshotCanvas(el, { nodes: [fileNode], edges: [] }, 0, 0, 1)!;
    expect(snap.glyphs.map((g) => g.ch).join("")).toBe("notes.md");
  });

  it("uses a link node's URL", () => {
    const el = makeViewport();
    const linkNode: CanvasLinkNode = {
      id: "l",
      type: "link",
      x: 0,
      y: 0,
      width: 400,
      height: 80,
      url: "https://x.test/a",
    };
    const snap = snapshotCanvas(el, { nodes: [linkNode], edges: [] }, 0, 0, 1)!;
    expect(snap.glyphs.map((g) => g.ch).join("")).toBe("https://x.test/a");
  });

  it("uses a group node's label, skipping label-less groups", () => {
    const el = makeViewport();
    const labeled: CanvasGroupNode = {
      id: "g1",
      type: "group",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      label: "Group A",
    };
    const unlabeled: CanvasGroupNode = {
      id: "g2",
      type: "group",
      x: 0,
      y: 100,
      width: 400,
      height: 200,
    };
    const snap = snapshotCanvas(
      el,
      { nodes: [labeled, unlabeled], edges: [] },
      0,
      0,
      1,
    )!;
    expect(snap.glyphs.map((g) => g.ch).join("")).toBe("Group A");
  });

  it("respects the maxGlyphs cap", () => {
    const el = makeViewport();
    const doc: CanvasDoc = {
      nodes: [textNode({ text: "x".repeat(100), width: 4000, height: 80 })],
      edges: [],
    };
    const snap = snapshotCanvas(el, doc, 0, 0, 1, 5)!;
    expect(snap.glyphs).toHaveLength(5);
  });

  it("does not count off-screen culled nodes against the cap", () => {
    const el = makeViewport(800, 600);
    const doc: CanvasDoc = {
      nodes: [
        textNode({ id: "off", text: "y".repeat(50), x: 9999, width: 4000 }),
        textNode({ id: "on", text: "abc", x: 0, width: 4000 }),
      ],
      edges: [],
    };
    // Cap of 3: if culling happened AFTER counting, the off-screen node's
    // 50 chars would consume the budget and "abc" would get zero glyphs.
    // Culling first means all 3 budget slots go to "abc".
    const snap = snapshotCanvas(el, doc, 0, 0, 1, 3)!;
    expect(snap.glyphs.map((g) => g.ch).join("")).toBe("abc");
  });

  it("returns a scrollerRect matching the viewport's bounding rect", () => {
    const el = makeViewport(640, 480);
    const doc: CanvasDoc = {
      nodes: [textNode({ text: "x" })],
      edges: [],
    };
    const snap = snapshotCanvas(el, doc, 0, 0, 1)!;
    expect(snap.scrollerRect.width).toBe(640);
    expect(snap.scrollerRect.height).toBe(480);
  });

  it("returns null when no node carries readable text", () => {
    const el = makeViewport();
    // file node with empty file, group with no label, unknown type
    const doc: CanvasDoc = {
      nodes: [
        { id: "f", type: "file", x: 0, y: 0, width: 100, height: 100, file: "" },
        { id: "g", type: "group", x: 0, y: 0, width: 100, height: 100 },
      ],
      edges: [],
    };
    expect(snapshotCanvas(el, doc, 0, 0, 1)).toBeNull();
  });
});
