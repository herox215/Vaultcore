// Regression for #355 — the Sidebar-level invariant: when a folder's
// relPath is already in `treeState.expanded` (because the user
// expanded it before locking), clicking the folder → entering the
// password → unlock-success must keep it expanded. A prior version
// of TreeRow called `onToggleExpand` from the unlock callback, which
// flipped the expanded set and collapsed the folder.
//
// The pure wiring test in TreeRowUnlockExpand.test.ts asserts that
// the unlock callback targets `onEnsureExpanded` (not toggle). This
// test validates the next layer down: that the Sidebar's
// `onEnsureExpanded` prop is wired to an idempotent helper and does
// not collapse an already-expanded relPath.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
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
  writeFile: vi.fn(),
  tagsList: vi.fn().mockResolvedValue([]),
  searchTagPaths: vi.fn().mockResolvedValue([]),
  renameFile: vi.fn(),
  lockFolder: vi.fn(),
  unlockFolder: vi.fn(),
  listEncryptedFolders: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
  listenEncryptedFoldersChanged: vi.fn().mockResolvedValue(() => {}),
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

import { listDirectory } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { loadTreeState, saveTreeState } from "../../../lib/treeState";
import Sidebar from "../Sidebar.svelte";
import type { DirEntry } from "../../../types/tree";

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
}

const VAULT = "/tmp/test-vault";

function lockedDir(name: string, path: string): DirEntry {
  return {
    name, path,
    is_dir: true, is_symlink: false, is_md: false,
    modified: null, created: null,
    encryption: "locked",
  };
}
function unlockedDir(name: string, path: string): DirEntry {
  return {
    name, path,
    is_dir: true, is_symlink: false, is_md: false,
    modified: null, created: null,
    encryption: "unlocked",
  };
}
function md(name: string, path: string): DirEntry {
  return { name, path, is_dir: false, is_symlink: false, is_md: true, modified: null, created: null };
}

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

describe("Sidebar unlock keeps folder expanded (#355)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    openUnlockModal.mockClear();
    vi.clearAllMocks();
  });

  it("unlock callback does not collapse a folder whose relPath was already in treeState.expanded", async () => {
    // Pre-seed the persisted tree state so "secret" is already in
    // `expanded` at mount — simulating the scenario where the user
    // expanded the folder before locking it.
    await saveTreeState(VAULT, { sortBy: "name", expanded: ["secret"] });

    const secret = lockedDir("secret", `${VAULT}/secret`);
    const secretUnlocked = unlockedDir("secret", `${VAULT}/secret`);
    const child = md("note.md", `${VAULT}/secret/note.md`);

    let unlockDone = false;
    (listDirectory as any).mockImplementation(async (path: string) => {
      if (path === VAULT) return [unlockDone ? secretUnlocked : secret];
      if (path === secret.path) return [child];
      return [];
    });

    render(Sidebar, { props: makeProps() });

    // Drain initial mount + load.
    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    // Click the locked folder → opens the unlock modal (not toggle).
    const row = Array.from(document.querySelectorAll(".vc-tree-row"))
      .find((n) => n.textContent?.includes("secret")) as HTMLElement | undefined;
    expect(row, "locked folder row rendered").toBeTruthy();
    row!.click();

    for (let i = 0; i < 5; i += 1) { await Promise.resolve(); await tick(); }

    expect(openUnlockModal).toHaveBeenCalledTimes(1);
    const callback = openUnlockModal.mock.calls[0][2];
    expect(callback).toBeTypeOf("function");

    // Simulate successful unlock on the backend: the parent listing now
    // returns the folder with encryption: "unlocked".
    unlockDone = true;
    await callback!();

    for (let i = 0; i < 30; i += 1) { await Promise.resolve(); await tick(); }

    // The invariant: "secret" must still be in persisted expanded set
    // (not collapsed by a stale toggle) AND the child must have been
    // loaded (children fetched by the ensure-expand path).
    const persisted = await loadTreeState(VAULT);
    expect(persisted.expanded).toContain("secret");

    const callsForSecret = (listDirectory as any).mock.calls
      .filter((c: [string]) => c[0] === secret.path);
    expect(callsForSecret.length).toBeGreaterThan(0);
  });
});
