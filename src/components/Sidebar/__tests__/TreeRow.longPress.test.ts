// TreeRow long-press → context menu (#387). Asserts:
//  1. File-row touch long-press opens the same custom menu the right-click
//     path opens, with menuPos coming from the synthesized coords.
//  2. Folder-row long-press shows the "New note here" entry.
//  3. Movement past the tolerance cancels the hold.
//  4. The existing right-click contextmenu path still works (coexistence
//     regression guard).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
  createFile: vi.fn(),
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

import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import TreeRow from "../TreeRow.svelte";
import type { FlatRow } from "../../../lib/flattenTree";

const VAULT = "/tmp/test-vault";

function fileRow(overrides: Partial<FlatRow> = {}): FlatRow {
  return {
    path: `${VAULT}/note.md`,
    relPath: "note.md",
    name: "note.md",
    depth: 0,
    isDir: false,
    isMd: true,
    isSymlink: false,
    expanded: false,
    loading: false,
    hasRenderedChildren: false,
    childrenLoaded: false,
    ...overrides,
  };
}

function folderRow(overrides: Partial<FlatRow> = {}): FlatRow {
  return fileRow({
    name: "folder",
    path: `${VAULT}/folder`,
    relPath: "folder",
    isDir: true,
    isMd: false,
    ...overrides,
  });
}

function makeProps(row: FlatRow) {
  return {
    row,
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onToggleExpand: vi.fn(),
    onEnsureExpanded: vi.fn(),
    onRefreshFolder: vi.fn(),
    onPathChanged: vi.fn(),
    onRequestRenameCascade: vi.fn(),
    onRequestMoveCascade: vi.fn(),
  };
}

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; pointerType?: string } = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: init.pointerId ?? 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "touch", configurable: true });
  return ev;
}

describe("TreeRow long-press → context menu (#387)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: ["note.md"], fileCount: 1 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the custom menu after a 500ms touch hold on a file row", async () => {
    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    expect(row).toBeTruthy();

    expect(container.querySelector(".vc-context-menu")).toBeNull();

    row.dispatchEvent(pointerEvent("pointerdown", { clientX: 70, clientY: 40 }));
    vi.advanceTimersByTime(500);
    await tick();

    const menu = container.querySelector(".vc-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.top).toBe("40px");
    expect(menu.style.left).toBe("70px");
  });

  it("folder row long-press shows the 'New note here' entry", async () => {
    const { container, getByText } = render(TreeRow, { props: makeProps(folderRow()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    row.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 20 }));
    vi.advanceTimersByTime(500);
    await tick();
    expect(getByText("New note here")).toBeTruthy();
  });

  it("a >10px move during hold cancels — menu does NOT open", async () => {
    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    row.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    document.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 0 }));
    vi.advanceTimersByTime(500);
    await tick();
    expect(container.querySelector(".vc-context-menu")).toBeNull();
  });

  it("desktop right-click contextmenu path still works (coexistence)", async () => {
    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 100, clientY: 50 });
    await tick();
    const menu = container.querySelector(".vc-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.top).toBe("50px");
    expect(menu.style.left).toBe("100px");
  });
});
