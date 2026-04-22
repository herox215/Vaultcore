// Regression for PR #336 blocker B3 — when `loadFolder` (listDirectory)
// rejects, the folder's relPath must NOT remain in the persisted
// `treeState.expanded` list. Otherwise the next launch shows the folder
// stuck expanded+empty, no spinner — the user has to collapse and re-expand
// to retry.
//
// We drive the reveal path (which funnels through `setExpanded`) because
// it's the easiest way to reach the expansion pipeline without poking
// internals. A deeper targeted test (direct setExpanded invocation) would
// require exposing it — here we rely on the observable side effect:
// persisted tree state.

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
import { treeRevealStore } from "../../../store/treeRevealStore";
import { loadTreeState } from "../../../lib/treeState";
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

function dir(name: string, path: string): DirEntry {
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

describe("Sidebar expand failure rollback (#336 B3)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("does not persist `expanded` for a folder whose listDirectory rejected", async () => {
    const foo = dir("foo", `${VAULT}/foo`);

    (listDirectory as any).mockImplementation(async (path: string) => {
      if (path === VAULT) return [foo];
      if (path === foo.path) throw new Error("EACCES: simulated permissions failure");
      return [];
    });

    render(Sidebar, { props: makeProps() });

    // Drain the initial root load.
    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    // Trigger the expansion pipeline via a reveal of a descendant. The
    // reveal pipeline calls setExpanded("foo", absFoo, true) — which will
    // invoke loadFolder(absFoo) → rejects. Under B3's contract, "foo" must
    // NOT survive in treeState.expanded.
    treeRevealStore.requestReveal("foo/any-descendant.md");

    // Flush everything.
    for (let i = 0; i < 60; i += 1) { await Promise.resolve(); await tick(); }

    // Read back the persisted tree state — this is what survives a reload.
    const persisted = await loadTreeState(VAULT);
    expect(persisted.expanded).not.toContain("foo");
  });
});
