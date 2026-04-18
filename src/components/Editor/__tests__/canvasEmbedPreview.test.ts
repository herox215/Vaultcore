// #156/#158 — the inline canvas embed mounts the shared CanvasRenderer
// with a fit-contain camera: the padded bbox scales to fit inside both
// the requested width and the max embed height, then centers horizontally
// when the height constraint wins. These tests lock in the pure camera
// math; renderer output is covered by CanvasRenderer.test.ts and E2E.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../../ipc/commands", () => ({
  readFile: vi.fn().mockResolvedValue(""),
}));

import { __computeEmbedCameraForTests } from "../embedPlugin";

describe("canvas embed fit-contain camera (#156/#158)", () => {
  it("width-driven branch: wide canvas fills the requested width and translates to its top-left", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "Hello", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "World", x: 200, y: 80, width: 120, height: 50 },
      ],
      edges: [{ id: "e", fromNode: "a", toNode: "b" }],
    });
    const cam = __computeEmbedCameraForTests(json, 600)!;
    // bbox = 0..320 × 0..130, pad=24 → 368 × 178.
    // widthZoom = 600/368 ≈ 1.63, heightZoom = 420/178 ≈ 2.36 → width wins.
    const expectedZoom = 600 / 368;
    expect(cam.zoom).toBeCloseTo(expectedZoom, 5);
    // No horizontal centering when width wins.
    expect(cam.camX).toBeCloseTo(24 * expectedZoom, 5);
    expect(cam.camY).toBeCloseTo(24 * expectedZoom, 5);
    expect(cam.heightPx).toBeCloseTo(178 * expectedZoom, 5);
  });

  it("height-driven branch: tall canvas scales to fit MAX_HEIGHT and centers horizontally (#158)", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 50, height: 50 },
        { id: "b", type: "text", text: "b", x: 0, y: 5000, width: 50, height: 50 },
      ],
      edges: [],
    });
    const cam = __computeEmbedCameraForTests(json, 600)!;
    // bbox = 0..50 × 0..5050, pad=24 → 98 × 5098.
    // widthZoom = 600/98 ≈ 6.12, heightZoom = 420/5098 ≈ 0.0824 → height wins.
    const expectedZoom = 420 / 5098;
    expect(cam.zoom).toBeCloseTo(expectedZoom, 5);
    // heightPx must equal MAX_HEIGHT — nothing gets cropped.
    expect(cam.heightPx).toBeCloseTo(420, 5);
    // Content width < widthPx, so it should be centered horizontally.
    const contentW = 98 * expectedZoom;
    const expectedOffsetX = (600 - contentW) / 2;
    expect(cam.camX).toBeCloseTo(24 * expectedZoom + expectedOffsetX, 5);
    expect(cam.camY).toBeCloseTo(24 * expectedZoom, 5);
  });

  it("never crops: a very tall canvas fits entirely inside [0, heightPx]", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "top", type: "text", text: "t", x: 0, y: 0, width: 100, height: 40 },
        { id: "bot", type: "text", text: "b", x: 0, y: 900, width: 100, height: 40 },
      ],
      edges: [],
    });
    const cam = __computeEmbedCameraForTests(json, 600)!;
    // After transform: worldY = camY + nodeY * zoom. The bottom node's far
    // edge must still be within the body height.
    const bottomFarEdgeY = cam.camY + (900 + 40) * cam.zoom;
    expect(bottomFarEdgeY).toBeLessThanOrEqual(cam.heightPx + 1e-6);
    // And the top node's top edge stays non-negative (padding above).
    const topEdgeY = cam.camY + 0 * cam.zoom;
    expect(topEdgeY).toBeGreaterThanOrEqual(0);
  });

  it("returns null when the canvas has no nodes (empty-placeholder path)", () => {
    const cam = __computeEmbedCameraForTests(
      JSON.stringify({ nodes: [], edges: [] }),
      600,
    );
    expect(cam).toBeNull();
  });

  it("treats nodes with missing width/height as default-sized so bbox stays finite", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "x", x: 10, y: 20 }, // no width/height
      ],
      edges: [],
    });
    const cam = __computeEmbedCameraForTests(json, 400)!;
    expect(Number.isFinite(cam.zoom)).toBe(true);
    expect(Number.isFinite(cam.heightPx)).toBe(true);
    expect(cam.heightPx).toBeGreaterThan(0);
  });
});
