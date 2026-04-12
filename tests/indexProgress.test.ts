import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// vi.hoisted ensures mockListen exists before vi.mock's factory runs
const { mockListen } = vi.hoisted(() => {
  const mockListen = vi.fn();
  return { mockListen };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

import { listenIndexProgress, INDEX_PROGRESS_EVENT } from "../src/ipc/events";
import { progressStore } from "../src/store/progressStore";

beforeEach(() => {
  mockListen.mockReset();
  progressStore.finish();
});

describe("IDX-02: vault://index_progress event wiring", () => {
  it("IDX-02: listenIndexProgress subscribes to the correct channel", async () => {
    mockListen.mockResolvedValue(() => {}); // UnlistenFn
    const handler = vi.fn();
    await listenIndexProgress(handler);
    expect(mockListen).toHaveBeenCalledWith(
      INDEX_PROGRESS_EVENT,
      expect.any(Function),
    );
  });

  it("IDX-02: handler receives { current, total, current_file } payload", async () => {
    let capturedCb: ((event: { payload: unknown }) => void) | null = null;
    mockListen.mockImplementation(
      (_name: string, cb: (event: { payload: unknown }) => void) => {
        capturedCb = cb;
        return Promise.resolve(() => {});
      },
    );
    const handler = vi.fn();
    await listenIndexProgress(handler);
    // Simulate a Tauri event
    capturedCb!({
      payload: { current: 5, total: 10, current_file: "notes/a.md" },
    });
    expect(handler).toHaveBeenCalledWith({
      current: 5,
      total: 10,
      current_file: "notes/a.md",
    });
  });

  it("IDX-02: progressStore.start -> update -> finish flow", () => {
    progressStore.start(100);
    expect(get(progressStore).active).toBe(true);
    expect(get(progressStore).total).toBe(100);
    progressStore.update(50, 100, "a.md");
    expect(get(progressStore).current).toBe(50);
    expect(get(progressStore).active).toBe(true);
    progressStore.update(100, 100, "z.md");
    // update() sets active = current < total
    expect(get(progressStore).active).toBe(false);
  });

  it("IDX-02: progressStore.finish() sets active to false", () => {
    progressStore.start(10);
    progressStore.finish();
    expect(get(progressStore).active).toBe(false);
  });
});
