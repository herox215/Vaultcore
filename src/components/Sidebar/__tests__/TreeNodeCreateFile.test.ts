// Originally the regression test for issue #50: creating a new file inside an
// expanded folder via the "New file here" context-menu entry must keep the
// folder expanded and show the freshly created child row.
//
// With the #253 virtualization refactor, expansion and child-list ownership
// moved out of the row component into Sidebar. TreeRow no longer owns its own
// expanded flag or children list — it delegates to `onToggleExpand` and
// `onRefreshFolder` callbacks. This test was updated to verify the equivalent
// contract at the TreeRow level:
//   1. Clicking "New file here" calls createFile with the folder path and an
//      empty seed.
//   2. It triggers the Sidebar to refresh the folder (so the new row appears
//      after the next flatten).
//   3. The newly created file is opened in a tab — this is what drives the
//      active-tab reveal hook that keeps the tree in sync.
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

import { createFile } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { tabStore } from "../../../store/tabStore";
import TreeRow from "../TreeRow.svelte";
import type { FlatRow } from "../../../lib/flattenTree";

const VAULT = "/tmp/test-vault";

function folderRow(overrides: Partial<FlatRow> = {}): FlatRow {
  return {
    path: `${VAULT}/folder`,
    relPath: "folder",
    name: "folder",
    depth: 0,
    isDir: true,
    isMd: false,
    isSymlink: false,
    expanded: true,
    loading: false,
    hasRenderedChildren: false,
    childrenLoaded: true,
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
    onRefreshFolder: vi.fn(),
    onPathChanged: vi.fn(),
  };
}

describe("TreeRow 'New file here' on a folder (#50, updated for #253)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    tabStore._reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("calls createFile and refreshes the folder so the new child appears", async () => {
    const newPath = `${VAULT}/folder/Unbenannte Notiz.md`;
    (createFile as any).mockResolvedValueOnce(newPath);

    const props = makeProps(folderRow());
    const { container } = render(TreeRow, { props });
    await tick();

    // Open the context menu via right-click on the row.
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    await tick();

    const newFileItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".vc-context-item"))
      .find((b) => b.textContent?.trim() === "New file here");
    expect(newFileItem).toBeTruthy();
    await fireEvent.click(newFileItem!);

    // Let the async create + refresh chain resolve.
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); await tick(); }

    expect(createFile).toHaveBeenCalledWith(`${VAULT}/folder`, "");
    // Sidebar is told to refresh the containing folder — this is what produces
    // the new child row after the next flatten.
    expect(props.onRefreshFolder).toHaveBeenCalledWith(`${VAULT}/folder`);
  });

  it("opens the newly created file in a tab so the active-tab reveal hook can sync the tree", async () => {
    const newPath = `${VAULT}/folder/Unbenannte Notiz.md`;
    (createFile as any).mockResolvedValueOnce(newPath);

    const openSpy = vi.spyOn(tabStore, "openTab");

    const { container } = render(TreeRow, { props: makeProps(folderRow()) });
    await tick();

    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    await tick();
    const newFileItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".vc-context-item"))
      .find((b) => b.textContent?.trim() === "New file here");
    await fireEvent.click(newFileItem!);

    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); await tick(); }

    expect(openSpy).toHaveBeenCalledWith(newPath);
  });
});
