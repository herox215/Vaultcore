// Pointer-mode state machine tests (#133).
//
// The module is pure: every assertion here goes through the same math the
// Canvas viewer runs at 60fps. If a regression slips here it will appear as
// drift under the cursor at runtime.

import { describe, it, expect } from "vitest";
import {
  MIN_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  beginPan,
  beginMove,
  beginResize,
  beginEdge,
  panPosition,
  movePosition,
  resizeSize,
  updateDraftOnMove,
  resolvePointerUp,
  type DraftEdge,
  type PointerMode,
} from "../pointerMode";
import type { CanvasTextNode } from "../types";

const node = (over: Partial<CanvasTextNode> = {}): CanvasTextNode => ({
  id: "n1",
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  text: "",
  ...over,
});

describe("beginPan", () => {
  it("snapshots pointer + camera so pan math is relative to start", () => {
    const mode = beginPan({ clientX: 50, clientY: 60 }, { x: 10, y: 20 });
    expect(mode).toEqual({
      kind: "pan",
      startClientX: 50,
      startClientY: 60,
      startCamX: 10,
      startCamY: 20,
    });
  });
});

describe("beginMove", () => {
  it("snapshots pointer + node origin", () => {
    const n = node({ x: 100, y: 200 });
    const mode = beginMove(n, { clientX: 5, clientY: 6 });
    expect(mode).toEqual({
      kind: "move",
      nodeId: "n1",
      startClientX: 5,
      startClientY: 6,
      startX: 100,
      startY: 200,
    });
  });
});

describe("beginResize", () => {
  it("snapshots pointer + node size", () => {
    const n = node({ width: 300, height: 150 });
    const mode = beginResize(n, { clientX: 12, clientY: 34 });
    expect(mode).toEqual({
      kind: "resize",
      nodeId: "n1",
      startClientX: 12,
      startClientY: 34,
      startW: 300,
      startH: 150,
    });
  });
});

describe("beginEdge", () => {
  it("produces an edge-mode keyed to the origin node + side", () => {
    expect(beginEdge("node-a", "right")).toEqual({
      kind: "edge",
      fromNodeId: "node-a",
      fromSide: "right",
    });
  });
});

describe("panPosition", () => {
  it("moves the camera by raw client delta (pan is not zoom-scaled)", () => {
    const mode: PointerMode = beginPan(
      { clientX: 100, clientY: 100 },
      { x: 0, y: 0 },
    );
    if (mode.kind !== "pan") throw new Error("unreachable");
    expect(panPosition(mode, { clientX: 130, clientY: 90 })).toEqual({
      camX: 30,
      camY: -10,
    });
  });

  it("is a pure function of start + current — repeat calls are stable", () => {
    const mode: PointerMode = beginPan(
      { clientX: 0, clientY: 0 },
      { x: 50, y: 50 },
    );
    if (mode.kind !== "pan") throw new Error("unreachable");
    const a = panPosition(mode, { clientX: 10, clientY: 10 });
    const b = panPosition(mode, { clientX: 10, clientY: 10 });
    expect(a).toEqual(b);
    expect(a).toEqual({ camX: 60, camY: 60 });
  });
});

describe("movePosition", () => {
  it("scales the client delta by 1/zoom so moves match cursor under zoom", () => {
    const mode: PointerMode = beginMove(
      node({ x: 0, y: 0 }),
      { clientX: 0, clientY: 0 },
    );
    if (mode.kind !== "move") throw new Error("unreachable");
    expect(movePosition(mode, { clientX: 200, clientY: 100 }, 2)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("at zoom=1 returns raw client delta + start", () => {
    const mode: PointerMode = beginMove(
      node({ x: 10, y: 20 }),
      { clientX: 100, clientY: 100 },
    );
    if (mode.kind !== "move") throw new Error("unreachable");
    expect(movePosition(mode, { clientX: 130, clientY: 140 }, 1)).toEqual({
      x: 40,
      y: 60,
    });
  });
});

describe("resizeSize", () => {
  it("grows width/height by zoom-scaled client delta", () => {
    const mode: PointerMode = beginResize(
      node({ width: 200, height: 100 }),
      { clientX: 0, clientY: 0 },
    );
    if (mode.kind !== "resize") throw new Error("unreachable");
    expect(resizeSize(mode, { clientX: 200, clientY: 100 }, 2)).toEqual({
      width: 300,
      height: 150,
    });
  });

  it("clamps shrinking below MIN_NODE_WIDTH / MIN_NODE_HEIGHT", () => {
    const mode: PointerMode = beginResize(
      node({ width: 100, height: 60 }),
      { clientX: 1000, clientY: 1000 },
    );
    if (mode.kind !== "resize") throw new Error("unreachable");
    const out = resizeSize(mode, { clientX: 0, clientY: 0 }, 1);
    expect(out.width).toBe(MIN_NODE_WIDTH);
    expect(out.height).toBe(MIN_NODE_HEIGHT);
  });

  it("clamps boundaries: exactly at the minimum does not go lower", () => {
    const mode: PointerMode = beginResize(
      node({ width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT }),
      { clientX: 0, clientY: 0 },
    );
    if (mode.kind !== "resize") throw new Error("unreachable");
    expect(resizeSize(mode, { clientX: -5, clientY: -5 }, 1)).toEqual({
      width: MIN_NODE_WIDTH,
      height: MIN_NODE_HEIGHT,
    });
  });
});

describe("updateDraftOnMove", () => {
  const baseDraft = (): DraftEdge => ({
    fromNodeId: "a",
    fromSide: "right",
    currentX: 0,
    currentY: 0,
    targetNodeId: null,
    targetSide: null,
  });

  it("tracks the cursor when no handle is under the pointer", () => {
    const out = updateDraftOnMove(baseDraft(), { x: 50, y: 60 }, null);
    expect(out).toEqual({
      fromNodeId: "a",
      fromSide: "right",
      currentX: 50,
      currentY: 60,
      targetNodeId: null,
      targetSide: null,
    });
  });

  it("snaps onto another node's handle", () => {
    const out = updateDraftOnMove(
      baseDraft(),
      { x: 50, y: 60 },
      { nodeId: "b", side: "left" },
    );
    expect(out.targetNodeId).toBe("b");
    expect(out.targetSide).toBe("left");
  });

  it("ignores self-loops: handle on the origin node does not snap", () => {
    const out = updateDraftOnMove(
      baseDraft(),
      { x: 50, y: 60 },
      { nodeId: "a", side: "top" },
    );
    expect(out.targetNodeId).toBeNull();
    expect(out.targetSide).toBeNull();
  });

  it("clears a previous snap when the pointer leaves the handle", () => {
    const snapped: DraftEdge = {
      ...baseDraft(),
      targetNodeId: "b",
      targetSide: "left",
    };
    const out = updateDraftOnMove(snapped, { x: 70, y: 80 }, null);
    expect(out.targetNodeId).toBeNull();
    expect(out.targetSide).toBeNull();
  });

  it("is immutable: does not mutate the input draft", () => {
    const input = baseDraft();
    updateDraftOnMove(input, { x: 9, y: 9 }, { nodeId: "b", side: "top" });
    expect(input.currentX).toBe(0);
    expect(input.targetNodeId).toBeNull();
  });
});

describe("resolvePointerUp", () => {
  const draftSnapped = (): DraftEdge => ({
    fromNodeId: "a",
    fromSide: "right",
    currentX: 0,
    currentY: 0,
    targetNodeId: "b",
    targetSide: "left",
  });

  it("commits an edge when the draft landed on a target handle", () => {
    const mode: PointerMode = beginEdge("a", "right");
    expect(resolvePointerUp(mode, draftSnapped())).toEqual({
      kind: "commit-edge",
      fromId: "a",
      fromSide: "right",
      toId: "b",
      toSide: "left",
    });
  });

  it("does nothing when the draft has no snap target", () => {
    const mode: PointerMode = beginEdge("a", "right");
    const draft: DraftEdge = {
      fromNodeId: "a",
      fromSide: "right",
      currentX: 99,
      currentY: 99,
      targetNodeId: null,
      targetSide: null,
    };
    expect(resolvePointerUp(mode, draft)).toEqual({ kind: "none" });
  });

  it("does nothing for non-edge modes even if a stale draft exists", () => {
    // Defensive: the component resets `draft` when entering other modes,
    // but a leak shouldn't fire a spurious commit.
    const mode: PointerMode = beginPan(
      { clientX: 0, clientY: 0 },
      { x: 0, y: 0 },
    );
    expect(resolvePointerUp(mode, draftSnapped())).toEqual({ kind: "none" });
  });

  it("does nothing when draft is null", () => {
    const mode: PointerMode = beginEdge("a", "right");
    expect(resolvePointerUp(mode, null)).toEqual({ kind: "none" });
  });
});
