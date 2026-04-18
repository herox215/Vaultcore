// #156 — CanvasRenderer is the pure presentation layer shared between
// CanvasView (interactive) and the CanvasEmbedWidget (read-only). These
// tests lock in: (a) that read-only mode hides the resize/edge handles
// and omits the pointer/keyboard handlers, and (b) that every node type
// renders its expected class + key data attributes so the E2E specs and
// the main view keep agreeing on the DOM contract.

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import CanvasRenderer from "../CanvasRenderer.svelte";
import type { CanvasDoc } from "../../../lib/canvas/types";

function docOf(nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"] = []): CanvasDoc {
  return { nodes, edges, extra: {} };
}

describe("CanvasRenderer (#156)", () => {
  it("renders each node type with its expected class and data-node-id", () => {
    const doc = docOf([
      { id: "t", type: "text", text: "Hello", x: 0, y: 0, width: 120, height: 40 },
      { id: "f", type: "file", file: "Note.md", x: 0, y: 50, width: 160, height: 80 },
      { id: "l", type: "link", url: "https://example.com", x: 0, y: 150, width: 160, height: 60 },
      { id: "g", type: "group", label: "Cluster", x: 0, y: 250, width: 300, height: 200 },
    ]);

    const { container } = render(CanvasRenderer, {
      props: { doc, interactive: true, vaultPath: "/vault" },
    });

    expect(container.querySelector('[data-node-id="t"].vc-canvas-node-text')).toBeTruthy();
    expect(container.querySelector('[data-node-id="f"].vc-canvas-node-file')).toBeTruthy();
    expect(container.querySelector('[data-node-id="l"].vc-canvas-node-link')).toBeTruthy();
    expect(container.querySelector('[data-node-id="g"].vc-canvas-node-group')).toBeTruthy();
  });

  it("text node content is visible inside the DOM (no 40-char truncation any more)", () => {
    const longText = "Line 1\nLine 2 that is long enough that the old SVG label would have cut it at forty characters.";
    const doc = docOf([
      { id: "t", type: "text", text: longText, x: 0, y: 0, width: 300, height: 120 },
    ]);
    const { container } = render(CanvasRenderer, { props: { doc, interactive: false } });
    const content = container.querySelector(".vc-canvas-node-content")!;
    expect(content.textContent).toBe(longText);
  });

  it("read-only mode (interactive=false) omits resize + edge handles", () => {
    const doc = docOf([
      { id: "t", type: "text", text: "x", x: 0, y: 0, width: 100, height: 40 },
    ]);
    const { container } = render(CanvasRenderer, { props: { doc, interactive: false } });
    expect(container.querySelector(".vc-canvas-resize-handle")).toBeNull();
    expect(container.querySelectorAll(".vc-canvas-edge-handle")).toHaveLength(0);
    expect(container.querySelector(".vc-canvas-readonly")).toBeTruthy();
  });

  it("interactive mode renders resize + edge handles for a text node", () => {
    const doc = docOf([
      { id: "t", type: "text", text: "x", x: 0, y: 0, width: 100, height: 40 },
    ]);
    const { container } = render(CanvasRenderer, { props: { doc, interactive: true } });
    expect(container.querySelector(".vc-canvas-resize-handle")).toBeTruthy();
    // Four sides per node → 4 handles.
    expect(container.querySelectorAll(".vc-canvas-edge-handle")).toHaveLength(4);
    expect(container.querySelector(".vc-canvas-readonly")).toBeNull();
  });

  it("renders one <path class='vc-canvas-edge'> per resolvable edge", () => {
    const doc = docOf(
      [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 200, y: 0, width: 100, height: 40 },
      ],
      [
        { id: "e1", fromNode: "a", toNode: "b" },
        { id: "ghost", fromNode: "a", toNode: "missing" },
      ],
    );
    const { container } = render(CanvasRenderer, { props: { doc, interactive: false } });
    // Orphaned edges are dropped by resolveEdges — only 1 visible path.
    expect(container.querySelectorAll("path.vc-canvas-edge")).toHaveLength(1);
  });

  it("applies the camera transform to the world container", () => {
    const doc = docOf([
      { id: "t", type: "text", text: "x", x: 0, y: 0, width: 100, height: 40 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: { doc, camX: 50, camY: 20, zoom: 0.5, interactive: false },
    });
    const world = container.querySelector<HTMLElement>(".vc-canvas-world")!;
    expect(world.style.transform).toContain("translate(50px, 20px)");
    expect(world.style.transform).toContain("scale(0.5)");
  });

  it("renders a group node with its label", () => {
    const doc = docOf([
      { id: "g", type: "group", label: "My group", x: 0, y: 0, width: 300, height: 200 },
    ]);
    const { container } = render(CanvasRenderer, { props: { doc, interactive: false } });
    const label = container.querySelector(".vc-canvas-node-group-label");
    expect(label?.textContent).toBe("My group");
  });

  it("renders the link URL inside a link node", () => {
    const doc = docOf([
      { id: "l", type: "link", url: "https://example.com", x: 0, y: 0, width: 160, height: 60 },
    ]);
    const { container } = render(CanvasRenderer, { props: { doc, interactive: false } });
    const url = container.querySelector(".vc-canvas-node-link-url");
    expect(url?.textContent).toBe("https://example.com");
  });

  it("file nodes pointing at an image render an <img> with the asset:// src", () => {
    const doc = docOf([
      { id: "f", type: "file", file: "pic.png", x: 0, y: 0, width: 200, height: 150 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: { doc, vaultPath: "/vault", interactive: false },
    });
    const img = container.querySelector<HTMLImageElement>("img.vc-canvas-node-image");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toContain("asset://localhost/");
    expect(img!.getAttribute("src")).toContain(encodeURIComponent("/vault/pic.png"));
  });

  it("markdown file nodes use the provided mdPreviews HTML", () => {
    const doc = docOf([
      { id: "f", type: "file", file: "Note.md", x: 0, y: 0, width: 240, height: 120 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: {
        doc,
        vaultPath: "/vault",
        interactive: false,
        mdPreviews: { "Note.md": "<h1>Heading from markdown</h1>" },
      },
    });
    const md = container.querySelector(".vc-canvas-node-md.markdown-body");
    expect(md?.innerHTML).toContain("<h1>Heading from markdown</h1>");
  });
});
