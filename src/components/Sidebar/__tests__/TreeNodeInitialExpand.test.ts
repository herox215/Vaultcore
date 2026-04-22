// Originally the regression test for issue #116 (`initiallyExpanded` as a
// one-shot seed on TreeNode). With the #253 virtualization refactor the
// Sidebar itself owns expansion state via the persisted `TreeState.expanded`
// list, and each TreeRow renders `aria-expanded` from its flat row's
// `expanded` flag. This test was updated to cover the equivalent contract:
// on mount, folders whose rel path is in the persisted expanded set render
// with aria-expanded="true".

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
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
}));

import { listDirectory } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import Sidebar from "../Sidebar.svelte";
import type { DirEntry } from "../../../types/tree";
import { vaultHashKey } from "../../../lib/treeState";

const VAULT = "/tmp/test-vault";

function dirEntry(name: string, path: string): DirEntry {
  return { name, path, is_dir: true, is_symlink: false, is_md: false, modified: null, created: null };
}

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

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

describe("Sidebar restores aria-expanded from persisted treeState (#116, updated for #253)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vi.clearAllMocks();
  });

  it("renders aria-expanded=\"true\" on a folder whose rel path is in persisted state", async () => {
    const folder = dirEntry("folder", `${VAULT}/folder`);
    (listDirectory as any).mockResolvedValue([folder]);

    // Seed persisted state BEFORE declaring the vault ready so Sidebar's
    // subscribe callback reads the seeded value on first fire.
    const key = await vaultHashKey(VAULT);
    localStorage.setItem(key, JSON.stringify({ sortBy: "name", expanded: ["folder"] }));
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });

    const { container } = render(Sidebar, { props: makeProps() });
    // Drain BOTH microtasks and macrotasks — crypto.subtle.digest (used by
    // vaultHashKey inside loadTreeState) resolves on a macrotask queue that
    // `await Promise.resolve()` does not drain.
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await tick();
    }

    const row = container.querySelector<HTMLElement>(`[data-tree-row="${folder.path}"]`);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders aria-expanded=\"false\" on a folder NOT in persisted state", async () => {
    const folder = dirEntry("folder", `${VAULT}/folder`);
    (listDirectory as any).mockResolvedValue([folder]);

    // No persisted state seeded — Sidebar falls back to DEFAULT_TREE_STATE.
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });

    const { container } = render(Sidebar, { props: makeProps() });
    for (let i = 0; i < 30; i += 1) { await Promise.resolve(); await tick(); }

    const row = container.querySelector<HTMLElement>(`[data-tree-row="${folder.path}"]`);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("aria-expanded")).toBe("false");
  });
});
