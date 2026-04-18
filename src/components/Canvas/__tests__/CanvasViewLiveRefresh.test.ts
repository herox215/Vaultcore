// #165 — markdown previews inside canvas file-nodes must live-refresh when
// the embedded note is saved from another tab. The CanvasView mounts with
// one file-node pointing at `Note.md`, then a simulated autosave from
// another tab fires `tabStore.setLastSavedContent` for that same path. We
// assert readFile is re-invoked so the preview repaints with the new body.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

// Mock the file-change listener so it's a no-op in vitest — the subscription
// lives at component level so we need a stub that returns an unlisten fn.
const listenFileChangeMock = vi.fn<
  (cb: (p: { path: string; new_path?: string }) => void) => Promise<() => void>
>();

vi.mock("../../../ipc/events", () => ({
  listenFileChange: (cb: (p: { path: string; new_path?: string }) => void) =>
    listenFileChangeMock(cb),
}));

const readFileMock = vi.fn<(path: string) => Promise<string>>();
const writeFileMock = vi.fn<(path: string, content: string) => Promise<void>>();

vi.mock("../../../ipc/commands", () => ({
  readFile: (path: string) => readFileMock(path),
  writeFile: (path: string, content: string) => writeFileMock(path, content),
}));

import CanvasView from "../CanvasView.svelte";
import { vaultStore } from "../../../store/vaultStore";
import { tabStore } from "../../../store/tabStore";
import type { CanvasDoc } from "../../../lib/canvas/types";

const VAULT = "/tmp/refresh-vault";
const CANVAS_ABS = `${VAULT}/Board.canvas`;
const NOTE_REL = "Notes/foo.md";
const NOTE_ABS = `${VAULT}/${NOTE_REL}`;

function docWithFileNode(): CanvasDoc {
  return {
    nodes: [
      {
        id: "fn",
        type: "file",
        file: NOTE_REL,
        x: 0,
        y: 0,
        width: 240,
        height: 140,
      },
    ],
    edges: [],
  };
}

async function waitForReadCount(n: number, path: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hits = readFileMock.mock.calls.filter((c) => c[0] === path).length;
    if (hits >= n) return;
    await tick();
    await new Promise((r) => setTimeout(r, 5));
  }
  const hits = readFileMock.mock.calls.filter((c) => c[0] === path).length;
  throw new Error(`expected ${n} reads of ${path}, got ${hits}`);
}

describe("CanvasView live-refresh of file-node previews (#165)", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    writeFileMock.mockReset();
    listenFileChangeMock.mockReset();
    listenFileChangeMock.mockResolvedValue(() => {});
    writeFileMock.mockResolvedValue(undefined);
    vaultStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [NOTE_REL], fileCount: 1 });
    tabStore._reset();
  });

  it("re-fetches the embedded note when tabStore.lastSavedContent for that file changes", async () => {
    // readFile must answer for the canvas file AND for the embedded note.
    readFileMock.mockImplementation(async (p) => {
      if (p === CANVAS_ABS) {
        return JSON.stringify(docWithFileNode(), null, "\t");
      }
      if (p === NOTE_ABS) {
        return "# Hello v1";
      }
      throw new Error(`unexpected read: ${p}`);
    });

    const { container } = render(CanvasView, {
      props: { tabId: "canvas-tab", abs: CANVAS_ABS },
    });

    // Wait for initial preview load.
    for (let i = 0; i < 30; i++) {
      await tick();
      if (container.querySelector(".vc-canvas-world")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitForReadCount(1, NOTE_ABS);
    expect(readFileMock.mock.calls.filter((c) => c[0] === NOTE_ABS)).toHaveLength(1);

    // Simulate another tab autosaving the same note.
    const noteTabId = tabStore.openTab(NOTE_ABS);
    tabStore.setLastSavedContent(noteTabId, "# Hello v2");

    // The invalidation should trigger a second read of the note file.
    await waitForReadCount(2, NOTE_ABS);
    expect(readFileMock.mock.calls.filter((c) => c[0] === NOTE_ABS)).toHaveLength(2);
  });

  it("re-fetches the embedded note when listenFileChange fires for its path", async () => {
    let watcherCb: ((p: { path: string; new_path?: string }) => void) | null = null;
    listenFileChangeMock.mockImplementation(async (cb) => {
      watcherCb = cb;
      return () => {};
    });

    readFileMock.mockImplementation(async (p) => {
      if (p === CANVAS_ABS) return JSON.stringify(docWithFileNode(), null, "\t");
      if (p === NOTE_ABS) return "# External v1";
      throw new Error(`unexpected read: ${p}`);
    });

    const { container } = render(CanvasView, {
      props: { tabId: "canvas-tab", abs: CANVAS_ABS },
    });

    for (let i = 0; i < 30; i++) {
      await tick();
      if (container.querySelector(".vc-canvas-world")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitForReadCount(1, NOTE_ABS);

    // Fire the watcher as if an external editor saved the file.
    expect(watcherCb).not.toBeNull();
    watcherCb!({ path: NOTE_ABS });

    await waitForReadCount(2, NOTE_ABS);
    expect(readFileMock.mock.calls.filter((c) => c[0] === NOTE_ABS)).toHaveLength(2);
  });

  it("ignores tabStore changes for files the canvas does not reference", async () => {
    readFileMock.mockImplementation(async (p) => {
      if (p === CANVAS_ABS) return JSON.stringify(docWithFileNode(), null, "\t");
      if (p === NOTE_ABS) return "# Hello";
      throw new Error(`unexpected read: ${p}`);
    });

    const { container } = render(CanvasView, {
      props: { tabId: "canvas-tab", abs: CANVAS_ABS },
    });
    for (let i = 0; i < 30; i++) {
      await tick();
      if (container.querySelector(".vc-canvas-world")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitForReadCount(1, NOTE_ABS);

    // Autosave an unrelated file — must not trigger a re-read.
    const otherTabId = tabStore.openTab(`${VAULT}/other.md`);
    tabStore.setLastSavedContent(otherTabId, "# unrelated");

    await new Promise((r) => setTimeout(r, 50));
    expect(readFileMock.mock.calls.filter((c) => c[0] === NOTE_ABS)).toHaveLength(1);
  });
});
