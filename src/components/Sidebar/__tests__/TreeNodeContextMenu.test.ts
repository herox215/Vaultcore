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
}));

import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import TreeNode from "../TreeNode.svelte";
import type { DirEntry } from "../../../types/tree";

const VAULT = "/tmp/test-vault";

function fileEntry(overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name: "note.md",
    path: `${VAULT}/note.md`,
    is_dir: false,
    is_symlink: false,
    is_md: true,
    modified: null,
    created: null,
    ...overrides,
  };
}

function makeProps(entry: DirEntry) {
  return {
    entry,
    depth: 0,
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onRefreshParent: vi.fn(),
    onPathChanged: vi.fn(),
  };
}

describe("TreeNode right-click context menu (#47)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: ["note.md"], fileCount: 1 });
  });

  it("opens our custom menu on contextmenu and calls preventDefault()", async () => {
    const { container } = render(TreeNode, { props: makeProps(fileEntry()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    expect(row).toBeTruthy();

    // Menu is not in the DOM before right-click.
    expect(container.querySelector(".vc-context-menu")).toBeNull();

    const evt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80,
    });
    const dispatched = row.dispatchEvent(evt);
    // dispatchEvent returns false when preventDefault() was called on a
    // cancelable event — which is the assertion we actually care about.
    expect(dispatched).toBe(false);
    expect(evt.defaultPrevented).toBe(true);

    await tick();
    const menu = container.querySelector(".vc-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    // Menu is positioned at the mouse coords via inline style.
    expect(menu.style.top).toBe("80px");
    expect(menu.style.left).toBe("120px");
  });

  it("contains Rename / Bookmark / Move to Trash entries for a file", async () => {
    const { container, getByText } = render(TreeNode, { props: makeProps(fileEntry()) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    await tick();

    expect(getByText("Rename")).toBeTruthy();
    expect(getByText("Bookmark")).toBeTruthy();
    expect(getByText("Move to Trash")).toBeTruthy();
  });

  it("contains New file / New folder entries for a directory", async () => {
    const dir = fileEntry({ name: "folder", path: `${VAULT}/folder`, is_dir: true, is_md: false });
    const { container, getByText } = render(TreeNode, { props: makeProps(dir) });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    await tick();

    expect(getByText("New file here")).toBeTruthy();
    expect(getByText("New folder here")).toBeTruthy();
  });
});
