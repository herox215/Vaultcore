// #154 — inline canvas embeds must refresh when their source .canvas file
// changes, whether the edit came through CanvasView autosave (internal) or
// an external editor (watcher). These tests lock in both invalidation
// hooks and the widget's value-comparing eq() that makes CM6 actually swap
// the DOM when the content changes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

// Capture the listenFileChange callback so tests can fire it manually —
// the module installs the subscription at import time. `vi.hoisted` keeps
// the handler slot visible to the hoisted vi.mock factory (plain closure
// variables would be TDZ-undefined at hoist time).
const handlerSlot = vi.hoisted(() => {
  const slot: { cb: ((p: { path: string; new_path?: string | null }) => void) | null } = { cb: null };
  return slot;
});
vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn(async (cb: (p: { path: string; new_path?: string | null }) => void) => {
    handlerSlot.cb = cb;
    return () => {
      handlerSlot.cb = null;
    };
  }),
}));
vi.mock("../../../ipc/commands", () => ({
  readFile: vi.fn().mockResolvedValue(""),
}));

import {
  __resetEmbedCachesForTests,
  __canvasCacheForTests,
  __canvasWidgetEqForTests,
} from "../embedPlugin";
import { vaultStore } from "../../../store/vaultStore";
import { tabStore } from "../../../store/tabStore";

describe("CanvasEmbedWidget cache invalidation (#154)", () => {
  beforeEach(() => {
    __resetEmbedCachesForTests();
    // Minimal vault so toVaultRel can produce a rel path for paths like
    // "/vault/Board.canvas" used in these tests.
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("eq() returns false when the cached canvas content differs", () => {
    const same = __canvasWidgetEqForTests(
      { relPath: "Board.canvas", widthPx: null, content: '{"nodes":[],"edges":[]}' },
      { relPath: "Board.canvas", widthPx: null, content: '{"nodes":[],"edges":[]}' },
    );
    expect(same).toBe(true);

    const differs = __canvasWidgetEqForTests(
      { relPath: "Board.canvas", widthPx: null, content: '{"nodes":[],"edges":[]}' },
      { relPath: "Board.canvas", widthPx: null, content: '{"nodes":[{"id":"a","type":"text","text":"x","x":0,"y":0,"width":10,"height":10}],"edges":[]}' },
    );
    expect(differs).toBe(false);
  });

  it("eq() returns false when the null placeholder meets real content (fetch completing)", () => {
    const stillLoading = { relPath: "Board.canvas", widthPx: null, content: null };
    const loaded = { relPath: "Board.canvas", widthPx: null, content: "{}" };
    expect(__canvasWidgetEqForTests(stillLoading, loaded)).toBe(false);
  });

  it("watcher file-change event drops the cached canvas entry", () => {
    __canvasCacheForTests.set("Board.canvas", "old-json");
    expect(__canvasCacheForTests.has("Board.canvas")).toBe(true);

    // Fire the watcher callback (captured by our mock of listenFileChange).
    expect(handlerSlot.cb).not.toBeNull();
    handlerSlot.cb!({ path: "/vault/Board.canvas", new_path: null });

    expect(__canvasCacheForTests.has("Board.canvas")).toBe(false);
  });

  it("watcher rename event invalidates both old and new paths", () => {
    __canvasCacheForTests.set("Old.canvas", "x");
    __canvasCacheForTests.set("New.canvas", "y");

    handlerSlot.cb!({ path: "/vault/Old.canvas", new_path: "/vault/New.canvas" });

    expect(__canvasCacheForTests.has("Old.canvas")).toBe(false);
    expect(__canvasCacheForTests.has("New.canvas")).toBe(false);
  });

  it("tabStore.setLastSavedContent on a .canvas tab invalidates the embed cache", async () => {
    __canvasCacheForTests.set("Board.canvas", "old-json");

    tabStore.openFileTab("/vault/Board.canvas", "canvas");
    const tabs = get(tabStore).tabs;
    const canvasTab = tabs.find((t) => t.filePath === "/vault/Board.canvas");
    expect(canvasTab).toBeTruthy();

    // CanvasView calls this after every successful writeFile.
    tabStore.setLastSavedContent(canvasTab!.id, "new-json");

    expect(__canvasCacheForTests.has("Board.canvas")).toBe(false);

    // Clean up the tab for test isolation.
    tabStore.closeTab(canvasTab!.id);
  });

  it("events outside the vault are ignored — no spurious invalidation", () => {
    __canvasCacheForTests.set("Board.canvas", "keep-me");

    handlerSlot.cb!({ path: "/other/Board.canvas", new_path: null });

    expect(__canvasCacheForTests.has("Board.canvas")).toBe(true);
  });
});
