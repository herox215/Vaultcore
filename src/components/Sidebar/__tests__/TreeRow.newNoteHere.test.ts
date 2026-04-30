// "New note here" via folder long-press (#387). Mirrors TreeNodeCreateFile
// for the touch path: folder long-press → click "New note here" → createFile
// is called with the long-pressed folder, the folder is refreshed, and the
// new note opens in a tab.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
  createFile: vi.fn().mockResolvedValue("/tmp/test-vault/folder/Untitled.md"),
  createFolder: vi.fn(),
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  updateLinksAfterRename: vi.fn(),
  getBacklinks: vi.fn().mockResolvedValue([]),
  loadBookmarks: vi.fn().mockResolvedValue([]),
  saveBookmarks: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn(),
  renameFile: vi.fn(),
}));

import { createFile } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { tabStore } from "../../../store/tabStore";
import TreeRow from "../TreeRow.svelte";
import type { FlatRow } from "../../../lib/flattenTree";

const VAULT = "/tmp/test-vault";

function folderRow(): FlatRow {
  return {
    path: `${VAULT}/folder`,
    relPath: "folder",
    name: "folder",
    depth: 0,
    isDir: true,
    isMd: false,
    isSymlink: false,
    expanded: false,
    loading: false,
    hasRenderedChildren: false,
    childrenLoaded: false,
  };
}

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerType?: string } = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "touch", configurable: true });
  return ev;
}

describe("TreeRow folder long-press → New note here (#387)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.useFakeTimers();
    vi.mocked(createFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clicking 'New note here' calls createFile, refreshes folder, opens tab", async () => {
    const onRefreshFolder = vi.fn();
    const onEnsureExpanded = vi.fn();
    const openTabSpy = vi.spyOn(tabStore, "openTab");
    const { container, getByText } = render(TreeRow, {
      props: {
        row: folderRow(),
        selectedPath: null,
        onSelect: vi.fn(),
        onOpenFile: vi.fn(),
        onToggleExpand: vi.fn(),
        onEnsureExpanded,
        onRefreshFolder,
        onPathChanged: vi.fn(),
        onRequestRenameCascade: vi.fn(),
        onRequestMoveCascade: vi.fn(),
      },
    });
    await tick();

    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    row.dispatchEvent(pointerEvent("pointerdown", { clientX: 5, clientY: 5 }));
    vi.advanceTimersByTime(500);
    await tick();

    const newNote = getByText("New note here");
    await fireEvent.click(newNote);
    // Async chain inside the handler — flush microtasks until createFile + tab open settle.
    await vi.runAllTimersAsync();
    await tick();

    expect(createFile).toHaveBeenCalledWith(`${VAULT}/folder`, "");
    expect(onRefreshFolder).toHaveBeenCalledWith(`${VAULT}/folder`);
    expect(openTabSpy).toHaveBeenCalledWith("/tmp/test-vault/folder/Untitled.md");
  });
});
