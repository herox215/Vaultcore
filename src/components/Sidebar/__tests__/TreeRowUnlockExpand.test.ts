// Regression: clicking a locked folder opens the password modal, and on
// successful unlock the folder must open *immediately* — a second click
// must not be required.
//
// The bug: `handleClick` used to call `onToggleExpand(row)` from the unlock
// callback. Because locking does not prune `treeState.expanded`, a folder
// that was expanded before being locked stayed in the expanded set while
// locked; toggling after unlock therefore *collapsed* the folder. The fix
// routes the unlock-success path through `onEnsureExpanded`, an idempotent
// guaranteed-expand that the Sidebar maps to `setExpanded(..., true)`.
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
  [string, string, (() => void | Promise<void>)?],
  void
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
  };
}

describe("TreeRow locked-folder unlock flow (#354 follow-up)", () => {
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
    expect(openUnlockModal.mock.calls[0][0]).toBe(`${VAULT}/secret`);
    expect(props.onToggleExpand).not.toHaveBeenCalled();
  });

  it("calls onEnsureExpanded (not onToggleExpand) on successful unlock", async () => {
    const props = makeProps(lockedFolderRow());
    const { container } = render(TreeRow, { props });
    await tick();
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    row.click();
    await tick();

    const unlockCallback = openUnlockModal.mock.calls[0][2];
    expect(unlockCallback).toBeTypeOf("function");
    await unlockCallback!();

    expect(props.onEnsureExpanded).toHaveBeenCalledTimes(1);
    expect(props.onEnsureExpanded.mock.calls[0][0]).toMatchObject({
      path: `${VAULT}/secret`,
      relPath: "secret",
    });
    // Toggle must not be used here — a toggle would *collapse* the folder
    // if its relPath happened to be in `treeState.expanded` from before
    // the lock, which is exactly the regression we're guarding against.
    expect(props.onToggleExpand).not.toHaveBeenCalled();
  });
});
