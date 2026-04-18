// #147 — inline canvas embed rendering. These tests drive the SVG preview
// helper that the CM6 embed widget calls after it fetches the .canvas file.
// We only need a DOM (jsdom) — no Tauri runtime — to assert that nodes and
// edges land in the SVG with auto-fit viewBox, and that empty / invalid
// canvases surface a friendly placeholder instead of blowing up.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../../ipc/commands", () => ({
  readFile: vi.fn().mockResolvedValue(""),
}));

import { __renderCanvasPreviewForTests } from "../embedPlugin";

function mountPreview(json: string): HTMLElement {
  const el = document.createElement("div");
  __renderCanvasPreviewForTests(el, json);
  return el;
}

describe("canvas embed preview (#147)", () => {
  it("renders one <rect> per node and one <line> per edge inside a viewBox that contains all nodes", () => {
    const doc = {
      nodes: [
        { id: "a", type: "text", text: "Hello", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "World", x: 200, y: 80, width: 120, height: 50 },
      ],
      edges: [{ id: "e", fromNode: "a", toNode: "b" }],
    };
    const el = mountPreview(JSON.stringify(doc));
    const svg = el.querySelector("svg")!;
    expect(svg).toBeTruthy();

    const viewBox = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
    const [vbX, vbY, vbW, vbH] = viewBox as [number, number, number, number];
    // minX=0, minY=0, maxX=320, maxY=130 with pad=20 → viewBox -20 -20 360 170
    expect(vbX).toBe(-20);
    expect(vbY).toBe(-20);
    expect(vbW).toBe(360);
    expect(vbH).toBe(170);

    expect(svg.querySelectorAll("rect")).toHaveLength(2);
    expect(svg.querySelectorAll("line")).toHaveLength(1);
    // Labels: first line of text for text nodes.
    const labels = Array.from(svg.querySelectorAll("text")).map((t) => t.textContent);
    expect(labels).toContain("Hello");
    expect(labels).toContain("World");
  });

  it("renders an (empty canvas) placeholder when the file has no nodes", () => {
    const el = mountPreview(JSON.stringify({ nodes: [], edges: [] }));
    expect(el.querySelector(".cm-embed-canvas-empty")).toBeTruthy();
    expect(el.textContent).toContain("empty canvas");
  });

  it("reports an invalid-canvas warning when the payload is not JSON", () => {
    const el = mountPreview("not-json");
    expect(el.textContent).toContain("invalid canvas file");
  });

  it("drops edges whose endpoints reference missing nodes without throwing", () => {
    const doc = {
      nodes: [{ id: "a", type: "text", text: "only", x: 0, y: 0, width: 80, height: 30 }],
      edges: [{ id: "dangling", fromNode: "a", toNode: "ghost" }],
    };
    const el = mountPreview(JSON.stringify(doc));
    const svg = el.querySelector("svg")!;
    expect(svg.querySelectorAll("rect")).toHaveLength(1);
    expect(svg.querySelectorAll("line")).toHaveLength(0);
  });
});
