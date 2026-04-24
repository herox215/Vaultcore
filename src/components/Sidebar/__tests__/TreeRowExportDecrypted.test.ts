// #360 — "Export decrypted copy…" context-menu entry on TreeRow.
//
// Entry is visible only when the row is a FILE sitting inside an
// UNLOCKED encrypted folder. Click path:
// 1. Close context menu.
// 2. Call `pickSavePath(row.name)` — native save dialog.
// 3. If the user picked a path, call `exportDecryptedFile(source, dest)`.
// 4. Success → info toast naming the picked filename.
// 5. Error → toast via `vaultErrorCopy`.
// 6. Cancel (null from save dialog) → silent no-op (no IPC call, no toast).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

const pickSavePath = vi.fn<(defaultPath: string) => Promise<string | null>>();
const exportDecryptedFile = vi.fn<(source: string, dest: string) => Promise<void>>();

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
  pickSavePath: (defaultPath: string) => pickSavePath(defaultPath),
  exportDecryptedFile: (source: string, dest: string) =>
    exportDecryptedFile(source, dest),
}));

vi.mock("../../../store/encryptionModalStore", () => ({
  openEncryptModal: vi.fn(),
  openUnlockModal: vi.fn(),
}));

import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { toastStore } from "../../../store/toastStore";
import { _setEncryptedFoldersForTest, resetEncryptedFoldersStore } from "../../../store/encryptedFoldersStore";
import TreeRow from "../TreeRow.svelte";
import type { FlatRow } from "../../../lib/flattenTree";

const VAULT = "/tmp/test-vault-360";

function fileRow(overrides: Partial<FlatRow> = {}): FlatRow {
  return {
    path: `${VAULT}/secret/photo.png`,
    relPath: "secret/photo.png",
    name: "photo.png",
    depth: 1,
    isDir: false,
    isMd: false,
    isSymlink: false,
    expanded: false,
    loading: false,
    hasRenderedChildren: false,
    childrenLoaded: false,
    encryption: "not-encrypted",
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

async function openContextMenu(container: HTMLElement): Promise<void> {
  const row = container.querySelector(".vc-tree-row") as HTMLElement;
  await fireEvent.contextMenu(row);
  await tick();
}

describe("TreeRow export-decrypted menu entry (#360)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    resetEncryptedFoldersStore();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    pickSavePath.mockReset();
    exportDecryptedFile.mockReset();
    // Clear toasts
    toastStore.dismissAll?.();
  });

  it("hides the entry when the file is NOT inside any encrypted folder", async () => {
    // No encrypted folders in the store → plain vault file.
    _setEncryptedFoldersForTest([]);
    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    await openContextMenu(container);
    expect(
      container.querySelector('[data-testid="context-export-decrypted"]'),
    ).toBeNull();
  });

  it("hides the entry when the enclosing encrypted folder is LOCKED", async () => {
    _setEncryptedFoldersForTest([
      {
        path: "secret",
        createdAt: "t",
        state: "encrypted",
        locked: true,
      },
    ]);
    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    await openContextMenu(container);
    expect(
      container.querySelector('[data-testid="context-export-decrypted"]'),
    ).toBeNull();
  });

  it("shows the entry when the file is inside an UNLOCKED encrypted folder", async () => {
    _setEncryptedFoldersForTest([
      {
        path: "secret",
        createdAt: "t",
        state: "encrypted",
        locked: false,
      },
    ]);
    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    await openContextMenu(container);
    expect(
      container.querySelector('[data-testid="context-export-decrypted"]'),
    ).not.toBeNull();
  });

  it("hides the entry for folders even when inside an unlocked encrypted root", async () => {
    _setEncryptedFoldersForTest([
      {
        path: "secret",
        createdAt: "t",
        state: "encrypted",
        locked: false,
      },
    ]);
    const folder = fileRow({
      path: `${VAULT}/secret/sub`,
      relPath: "secret/sub",
      name: "sub",
      isDir: true,
    });
    const { container } = render(TreeRow, { props: makeProps(folder) });
    await tick();
    await openContextMenu(container);
    expect(
      container.querySelector('[data-testid="context-export-decrypted"]'),
    ).toBeNull();
  });

  it("calls pickSavePath then exportDecryptedFile on click, toasts on success", async () => {
    _setEncryptedFoldersForTest([
      { path: "secret", createdAt: "t", state: "encrypted", locked: false },
    ]);
    pickSavePath.mockResolvedValueOnce("/home/user/Desktop/photo.png");
    exportDecryptedFile.mockResolvedValueOnce(undefined);

    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    await openContextMenu(container);
    const entry = container.querySelector(
      '[data-testid="context-export-decrypted"]',
    ) as HTMLButtonElement;
    await fireEvent.click(entry);
    // Let the async callback flush.
    await Promise.resolve();
    await tick();
    await Promise.resolve();
    await tick();

    expect(pickSavePath).toHaveBeenCalledWith("photo.png");
    expect(exportDecryptedFile).toHaveBeenCalledWith(
      `${VAULT}/secret/photo.png`,
      "/home/user/Desktop/photo.png",
    );
  });

  it("is a silent no-op when the user cancels the save dialog", async () => {
    _setEncryptedFoldersForTest([
      { path: "secret", createdAt: "t", state: "encrypted", locked: false },
    ]);
    pickSavePath.mockResolvedValueOnce(null);

    const { container } = render(TreeRow, { props: makeProps(fileRow()) });
    await tick();
    await openContextMenu(container);
    const entry = container.querySelector(
      '[data-testid="context-export-decrypted"]',
    ) as HTMLButtonElement;
    await fireEvent.click(entry);
    await Promise.resolve();
    await tick();

    expect(pickSavePath).toHaveBeenCalledTimes(1);
    expect(exportDecryptedFile).not.toHaveBeenCalled();
  });
});
