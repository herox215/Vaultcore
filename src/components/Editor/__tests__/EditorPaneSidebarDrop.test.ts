/**
 * #146 — EditorPane accepts sidebar file drops for split-view.
 *
 * Covers the two drag branches the pane now distinguishes:
 *  - `text/vaultcore-tab` → existing tab-reorder into another pane (unchanged).
 *  - `text/vaultcore-file` → open the dropped file (reusing an existing tab
 *     if one exists) and move it into the target pane.
 * Folder drags carry `text/vaultcore-folder` and must be ignored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock("../../../ipc/commands", () => ({
  readFile,
  writeFile: vi.fn().mockResolvedValue("0".repeat(64)),
  getFileHash: vi.fn().mockResolvedValue("0".repeat(64)),
  mergeExternalChange: vi.fn().mockResolvedValue({ outcome: "clean", merged_content: "" }),
  getResolvedLinks: vi.fn().mockResolvedValue(new Map()),
  getResolvedAttachments: vi.fn().mockResolvedValue(new Map()),
  createFile: vi.fn().mockResolvedValue(""),
  getLinkGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  getLocalGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  getBacklinks: vi.fn().mockResolvedValue([]),
  getOutgoingLinks: vi.fn().mockResolvedValue([]),
  getUnresolvedLinks: vi.fn().mockResolvedValue([]),
  listTags: vi.fn().mockResolvedValue([]),
  countWikiLinks: vi.fn().mockResolvedValue(0),
  suggestLinks: vi.fn().mockResolvedValue([]),
  searchFulltext: vi.fn().mockResolvedValue([]),
  searchFilename: vi.fn().mockResolvedValue([]),
  listDirectory: vi.fn().mockResolvedValue([]),
  invoke: vi.fn(),
  normalizeError: (e: unknown) => e,
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenVaultStatus: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
  listenIndexProgress: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../Graph/GraphView.svelte", async () => {
  // @ts-ignore svelte-check can't resolve this via the shim
  const { default: Empty } = await import("./emptyComponent.svelte");
  return { default: Empty };
});
vi.mock("../../Graph/graphRender", () => ({
  mountGraph: vi.fn(),
  updateGraph: vi.fn(),
  destroyGraph: vi.fn(),
  DEFAULT_FORCE_SETTINGS: {},
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${encodeURIComponent(p)}`,
}));

import { tabStore } from "../../../store/tabStore";
import { vaultStore } from "../../../store/vaultStore";
import { get } from "svelte/store";
import EditorPane from "../EditorPane.svelte";

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await tick();
  }
}

/**
 * Build a DragEvent whose dataTransfer mirrors a sidebar drag: `types`
 * reports the MIME keys and `getData(mime)` returns the encoded path.
 * jsdom's DataTransfer is read-only after construction, so we fake it.
 */
function makeDragEvent(
  type: "dragover" | "drop",
  entries: Array<[string, string]>,
  opts: { clientX: number; clientY?: number },
): DragEvent {
  const map = new Map(entries);
  const dt = {
    types: Array.from(map.keys()),
    getData: (k: string) => map.get(k) ?? "",
    setData: vi.fn(),
    effectAllowed: "move",
    dropEffect: "move",
  } as unknown as DataTransfer;
  const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, "dataTransfer", { value: dt, writable: false });
  Object.defineProperty(ev, "clientX", { value: opts.clientX });
  Object.defineProperty(ev, "clientY", { value: opts.clientY ?? 100 });
  return ev;
}

function fakeBoundingRect(el: HTMLElement, width = 800, height = 600): void {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("EditorPane sidebar-file drop (#146)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
    readFile.mockReset().mockResolvedValue("seed contents");
  });

  it("dropping a .md path on the right edge opens the file in a right-pane split", async () => {
    tabStore.openTab("/vault/seed.md");
    await flushAsync();

    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const pane = container.querySelector<HTMLDivElement>(".vc-editor-pane")!;
    fakeBoundingRect(pane);

    // Hover near the right edge so splitIndicatorSide = "right".
    pane.dispatchEvent(
      makeDragEvent("dragover", [["text/vaultcore-file", "/vault/note.md"]], { clientX: 790 }),
    );
    await tick();

    pane.dispatchEvent(
      makeDragEvent("drop", [["text/vaultcore-file", "/vault/note.md"]], { clientX: 790 }),
    );
    await flushAsync();

    const state = get(tabStore);
    const noteTab = state.tabs.find((t) => t.filePath === "/vault/note.md");
    expect(noteTab).toBeTruthy();
    expect(state.splitState.right).toContain(noteTab!.id);
    expect(state.splitState.left).not.toContain(noteTab!.id);
  });

  it("dropping a file whose tab already exists reuses it instead of creating a duplicate", async () => {
    const existingId = tabStore.openTab("/vault/existing.md");
    tabStore.openTab("/vault/other.md"); // so the left pane has > 1 tab after moveToPane
    await flushAsync();

    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const pane = container.querySelector<HTMLDivElement>(".vc-editor-pane")!;
    fakeBoundingRect(pane);

    pane.dispatchEvent(
      makeDragEvent("dragover", [["text/vaultcore-file", "/vault/existing.md"]], { clientX: 790 }),
    );
    await tick();
    pane.dispatchEvent(
      makeDragEvent("drop", [["text/vaultcore-file", "/vault/existing.md"]], { clientX: 790 }),
    );
    await flushAsync();

    const state = get(tabStore);
    const tabsForPath = state.tabs.filter((t) => t.filePath === "/vault/existing.md");
    expect(tabsForPath).toHaveLength(1);
    expect(tabsForPath[0]!.id).toBe(existingId);
    expect(state.splitState.right).toContain(existingId);
  });

  it("dropping a folder drag (text/vaultcore-folder) is a no-op", async () => {
    tabStore.openTab("/vault/seed.md");
    await flushAsync();
    const stateBefore = get(tabStore);

    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const pane = container.querySelector<HTMLDivElement>(".vc-editor-pane")!;
    fakeBoundingRect(pane);

    // dragover should not set an indicator; drop should not open anything.
    pane.dispatchEvent(
      makeDragEvent("dragover", [["text/vaultcore-folder", "/vault/sub"]], { clientX: 790 }),
    );
    await tick();
    pane.dispatchEvent(
      makeDragEvent("drop", [["text/vaultcore-folder", "/vault/sub"]], { clientX: 790 }),
    );
    await flushAsync();

    const stateAfter = get(tabStore);
    expect(stateAfter.tabs).toHaveLength(stateBefore.tabs.length);
    expect(stateAfter.splitState.right).toHaveLength(0);
  });

  it("dropping in the middle of the pane (no edge) does nothing", async () => {
    tabStore.openTab("/vault/seed.md");
    await flushAsync();

    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const pane = container.querySelector<HTMLDivElement>(".vc-editor-pane")!;
    fakeBoundingRect(pane);

    pane.dispatchEvent(
      makeDragEvent("dragover", [["text/vaultcore-file", "/vault/note.md"]], { clientX: 400 }),
    );
    await tick();
    pane.dispatchEvent(
      makeDragEvent("drop", [["text/vaultcore-file", "/vault/note.md"]], { clientX: 400 }),
    );
    await flushAsync();

    const state = get(tabStore);
    expect(state.tabs.find((t) => t.filePath === "/vault/note.md")).toBeUndefined();
    expect(state.splitState.right).toHaveLength(0);
  });

  it("tab-drag payload still moves the dragged tab to the target pane (regression)", async () => {
    const id = tabStore.openTab("/vault/a.md");
    tabStore.openTab("/vault/b.md"); // keep left non-empty so split is created, not collapsed
    await flushAsync();

    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const pane = container.querySelector<HTMLDivElement>(".vc-editor-pane")!;
    fakeBoundingRect(pane);

    pane.dispatchEvent(
      makeDragEvent("dragover", [["text/vaultcore-tab", id]], { clientX: 790 }),
    );
    await tick();
    pane.dispatchEvent(
      makeDragEvent("drop", [["text/vaultcore-tab", id]], { clientX: 790 }),
    );
    await flushAsync();

    const state = get(tabStore);
    expect(state.splitState.right).toContain(id);
    expect(state.splitState.left).not.toContain(id);
  });
});
