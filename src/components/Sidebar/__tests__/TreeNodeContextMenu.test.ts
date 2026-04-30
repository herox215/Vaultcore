// #47 right-click context menu — updated for #253. TreeRow is the flat-row
// component that replaced TreeNode; the context-menu behaviour is identical.
import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("TreeRow right-click context menu (#47, updated for #253)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: ["note.md"], fileCount: 1 });
  });

  it("opens our custom menu on contextmenu and calls preventDefault()", async () => {
    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    expect(row).toBeTruthy();

    expect(container.querySelector(".vc-context-menu")).toBeNull();

    const evt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80,
    });
    const dispatched = row.dispatchEvent(evt);
    expect(dispatched).toBe(false);
    expect(evt.defaultPrevented).toBe(true);

    await tick();
    const menu = container.querySelector(".vc-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.top).toBe("80px");
    expect(menu.style.left).toBe("120px");
  });

  it("contains Rename / Bookmark / Move to Trash entries for a file", async () => {
    const { container, getByText } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    await tick();

    expect(getByText("Rename")).toBeTruthy();
    expect(getByText("Bookmark")).toBeTruthy();
    expect(getByText("Move to Trash")).toBeTruthy();
  });

  it("contains New file / New folder entries for a directory", async () => {
    const dir = fileRow({
      name: "folder",
      path: `${VAULT}/folder`,
      relPath: "folder",
      isDir: true,
      isMd: false,
    });
    const { container, getByText } = render(TreeRow, { props: makeProps(dir) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    await tick();

    expect(getByText("New file here")).toBeTruthy();
    expect(getByText("New folder here")).toBeTruthy();
  });
});
