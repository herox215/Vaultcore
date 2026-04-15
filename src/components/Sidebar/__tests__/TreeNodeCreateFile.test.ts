// Regression test for issue #50: creating a new file inside an expanded folder
// via the "New file here" context-menu entry must keep the folder expanded and
// show the freshly created child row.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  updateLinksAfterRename: vi.fn(),
  getBacklinks: vi.fn().mockResolvedValue([]),
  loadBookmarks: vi.fn().mockResolvedValue([]),
  saveBookmarks: vi.fn().mockResolvedValue(undefined),
}));

import { listDirectory, createFile } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { tabStore } from "../../../store/tabStore";
import TreeNode from "../TreeNode.svelte";
import type { DirEntry } from "../../../types/tree";

const VAULT = "/tmp/test-vault";

function dirEntry(overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name: "folder",
    path: `${VAULT}/folder`,
    is_dir: true,
    is_symlink: false,
    is_md: false,
    modified: null,
    created: null,
    ...overrides,
  };
}

function fileEntry(overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name: "existing.md",
    path: `${VAULT}/folder/existing.md`,
    is_dir: false,
    is_symlink: false,
    is_md: true,
    modified: null,
    created: null,
    ...overrides,
  };
}

function makeProps(entry: DirEntry, initiallyExpanded = true) {
  return {
    entry,
    depth: 0,
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onRefreshParent: vi.fn(),
    onPathChanged: vi.fn(),
    initiallyExpanded,
  };
}

describe("TreeNode 'New file here' keeps folder expanded (#50)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    tabStore._reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("leaves the folder expanded and renders the new child after creation", async () => {
    const existing = fileEntry();
    const newFile = fileEntry({ name: "Unbenannte Notiz.md", path: `${VAULT}/folder/Unbenannte Notiz.md` });

    (listDirectory as any).mockResolvedValueOnce([existing]);
    (createFile as any).mockResolvedValueOnce(newFile.path);
    (listDirectory as any).mockResolvedValueOnce([existing, newFile]);

    const { container } = render(TreeNode, { props: makeProps(dirEntry(), true) });

    // Let onMount + initial loadChildren resolve.
    await tick();
    await tick();

    // Folder is expanded and the existing child is rendered.
    const nodeEl = container.querySelector(".vc-tree-node") as HTMLElement;
    expect(nodeEl.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("existing.md");

    // Open context menu via right-click and pick "New file here".
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    await tick();
    const newFileItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".vc-context-item"))
      .find((b) => b.textContent?.trim() === "New file here");
    expect(newFileItem).toBeTruthy();
    await fireEvent.click(newFileItem!);

    // Flush the create + reload.
    await tick();
    await tick();
    await tick();

    expect(createFile).toHaveBeenCalledWith(`${VAULT}/folder`, "");

    const nodeAfter = container.querySelector(".vc-tree-node") as HTMLElement;
    expect(nodeAfter.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Unbenannte Notiz.md");
    expect(container.textContent).toContain("existing.md");
  });

  it("opens the newly created file in a tab so the active-tab reveal hook can sync the tree", async () => {
    const newFile = fileEntry({ name: "Unbenannte Notiz.md", path: `${VAULT}/folder/Unbenannte Notiz.md` });

    (listDirectory as any).mockResolvedValue([]);
    (createFile as any).mockResolvedValueOnce(newFile.path);

    const openSpy = vi.spyOn(tabStore, "openTab");

    const { container } = render(TreeNode, { props: makeProps(dirEntry(), true) });
    await tick();
    await tick();

    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    await tick();
    const newFileItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".vc-context-item"))
      .find((b) => b.textContent?.trim() === "New file here");
    await fireEvent.click(newFileItem!);
    await tick();
    await tick();

    expect(openSpy).toHaveBeenCalledWith(newFile.path);
  });
});
