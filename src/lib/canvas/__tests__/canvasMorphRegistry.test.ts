// Unit tests for the canvas-snapshot registry (#383).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerCanvasSnapshot,
  snapshotCanvasTab,
  unregisterCanvasSnapshot,
} from "../canvasMorphRegistry";
import type { ViewSnapshot } from "../../morphTypes";

function snap(tag: string): ViewSnapshot {
  return {
    glyphs: [{ ch: tag, x: 0, y: 0 }],
    lineHeight: 16,
    font: "14px sans-serif",
    color: "#000",
    scrollerRect: { x: 0, y: 0, width: 100, height: 100 },
  };
}

const idsToCleanUp: string[] = [];
afterEach(() => {
  for (const id of idsToCleanUp) unregisterCanvasSnapshot(id);
  idsToCleanUp.length = 0;
});

describe("canvasMorphRegistry", () => {
  it("returns null for an unknown tab", () => {
    expect(snapshotCanvasTab("never-registered")).toBeNull();
  });

  it("invokes the registered fn at lookup time", () => {
    const id = "tab-A";
    idsToCleanUp.push(id);
    registerCanvasSnapshot(id, () => snap("A"));
    const result = snapshotCanvasTab(id);
    expect(result?.glyphs[0]!.ch).toBe("A");
  });

  it("isolates two simultaneously registered tabs", () => {
    idsToCleanUp.push("tab-A", "tab-B");
    registerCanvasSnapshot("tab-A", () => snap("A"));
    registerCanvasSnapshot("tab-B", () => snap("B"));
    expect(snapshotCanvasTab("tab-A")?.glyphs[0]!.ch).toBe("A");
    expect(snapshotCanvasTab("tab-B")?.glyphs[0]!.ch).toBe("B");
  });

  it("returns null after unregister even if a fresh registration was created earlier with the same id", () => {
    const id = "tab-A";
    idsToCleanUp.push(id);
    registerCanvasSnapshot(id, () => snap("A"));
    unregisterCanvasSnapshot(id);
    expect(snapshotCanvasTab(id)).toBeNull();
  });

  it("re-registering with the same id replaces the old fn (no stale closure leak on remount)", () => {
    const id = "tab-A";
    idsToCleanUp.push(id);
    registerCanvasSnapshot(id, () => snap("first"));
    registerCanvasSnapshot(id, () => snap("second"));
    expect(snapshotCanvasTab(id)?.glyphs[0]!.ch).toBe("second");
  });

  it("propagates a null return from the fn (e.g. empty / unloaded canvas)", () => {
    const id = "tab-A";
    idsToCleanUp.push(id);
    registerCanvasSnapshot(id, () => null);
    expect(snapshotCanvasTab(id)).toBeNull();
  });
});
