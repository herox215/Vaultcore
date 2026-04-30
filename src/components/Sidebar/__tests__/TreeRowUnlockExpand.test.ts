// Regression for #355: clicking a locked folder opens the password
// modal, and on successful unlock the folder must open *immediately* —
// a second click must not be required.
//
// Original bug: `handleClick` called `onToggleExpand(row)` from the
// unlock callback. Locking does not prune `treeState.expanded`, so a
// folder that was expanded before being locked still had its relPath
// in the set while locked; toggling after unlock therefore *collapsed*
// it. The fix routes through `onEnsureExpanded` (idempotent
// guaranteed-expand) and refreshes the parent listing first so the
// flat row's cached `encryption` flag is fresh before flattenTree
// decides whether to descend.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
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
  lockFolder: vi.fn(),
  unlockFolder: vi.fn(),
}));

const openUnlockModal = vi.fn<
  (path: string, label: string, cb?: () => void | Promise<void>) => void
>();

vi.mock("../../../store/encryptionModalStore", () => ({
  openEncryptModal: vi.fn(),
  openUnlockModal: (path: string, label: string, cb?: () => void | Promise<void>) => {
    openUnlockModal(path, label, cb);
  },
}));

import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import TreeRow from "../TreeRow.svelte";
import type { FlatRow } from "../../../lib/flattenTree";

const VAULT = "/tmp/test-vault";

function lockedFolderRow(overrides: Partial<FlatRow> = {}): FlatRow {
  return {
    path: `${VAULT}/secret`,
    relPath: "secret",
    name: "secret",
    depth: 0,
    isDir: true,
    isMd: false,
    isSymlink: false,
    expanded: false,
    loading: false,
    hasRenderedChildren: false,
    childrenLoaded: false,
    encryption: "locked",
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

describe("TreeRow locked-folder unlock flow (#355)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    openUnlockModal.mockClear();
  });

  it("opens the unlock modal when a locked folder is clicked, not toggle", async () => {
    const props = makeProps(lockedFolderRow());
    const { container } = render(TreeRow, { props });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    row.click();
    await tick();

    expect(openUnlockModal).toHaveBeenCalledTimes(1);
    expect(openUnlockModal.mock.calls[0]![0]).toBe(`${VAULT}/secret`);
    expect(props.onToggleExpand).not.toHaveBeenCalled();
  });

  it("refreshes the parent, then ensures-expand, on successful unlock", async () => {
    const props = makeProps(lockedFolderRow());
    const { container } = render(TreeRow, { props });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    row.click();
    await tick();

    // Track ordering: the parent refresh must complete before the
    // ensure-expand fires, otherwise the flat row's cached
    // `encryption: "locked"` flag is still in effect when flattenTree
    // decides whether to descend into children, producing a brief
    // "expanded but empty" flash.
    const order: string[] = [];
    props.onRefreshFolder.mockImplementation(async () => {
      order.push("refresh");
    });
    props.onEnsureExpanded.mockImplementation(async () => {
      order.push("ensure");
    });

    const unlockCallback = openUnlockModal.mock.calls[0]![2];
    expect(unlockCallback).toBeTypeOf("function");
    await unlockCallback!();

    expect(order).toEqual(["refresh", "ensure"]);
    expect(props.onRefreshFolder).toHaveBeenCalledWith(VAULT);
    expect(props.onEnsureExpanded).toHaveBeenCalledTimes(1);
    expect(props.onEnsureExpanded.mock.calls[0]![0]).toMatchObject({
      path: `${VAULT}/secret`,
      relPath: "secret",
    });
    // Toggle must not be used here — a toggle would *collapse* the folder
    // if its relPath happened to be in `treeState.expanded` from before
    // the lock, which is exactly the regression we're guarding against.
    expect(props.onToggleExpand).not.toHaveBeenCalled();
  });

  it("refreshes the nested parent (not vault root) for a deeper locked folder", async () => {
    const nested = lockedFolderRow({
      path: `${VAULT}/outer/secret`,
      relPath: "outer/secret",
      depth: 1,
    });
    const props = makeProps(nested);
    const { container } = render(TreeRow, { props });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    row.click();
    await tick();

    const unlockCallback = openUnlockModal.mock.calls[0]![2];
    await unlockCallback!();

    expect(props.onRefreshFolder).toHaveBeenCalledWith(`${VAULT}/outer`);
  });
});
