// #156 — the inline canvas embed now mounts the shared CanvasRenderer
// with a fit-to-width camera. These tests lock in the pure camera math
// (bounding box + zoom + height cap) that the widget uses; renderer
// output itself is covered by CanvasRenderer.test.ts and the E2E specs.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../../ipc/commands", () => ({
  readFile: vi.fn().mockResolvedValue(""),
}));

import { __computeEmbedCameraForTests } from "../embedPlugin";

describe("canvas embed fit-to-width camera (#156)", () => {
  it("zooms the bounding box to the requested width and translates to its top-left", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "Hello", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "World", x: 200, y: 80, width: 120, height: 50 },
      ],
      edges: [{ id: "e", fromNode: "a", toNode: "b" }],
    });
    const cam = __computeEmbedCameraForTests(json, 600)!;
    // bbox = 0..320 × 0..130, pad=24 on both sides → 368 × 178
    // zoom = 600 / 368, camX/camY translate the padded origin to (0,0).
    const expectedZoom = 600 / 368;
    expect(cam.zoom).toBeCloseTo(expectedZoom, 5);
    expect(cam.camX).toBeCloseTo(24 * expectedZoom, 5);
    expect(cam.camY).toBeCloseTo(24 * expectedZoom, 5);
    // heightPx = 178 * zoom, clamped to [80, 420].
    expect(cam.heightPx).toBeCloseTo(178 * expectedZoom, 5);
  });

  it("caps the height at the embed's max when the canvas is very tall", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 50, height: 50 },
        { id: "b", type: "text", text: "b", x: 0, y: 5000, width: 50, height: 50 },
      ],
      edges: [],
    });
    const cam = __computeEmbedCameraForTests(json, 600)!;
    expect(cam.heightPx).toBeLessThanOrEqual(420);
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
