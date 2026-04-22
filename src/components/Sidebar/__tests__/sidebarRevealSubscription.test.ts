// TDD for #253: Sidebar must subscribe to `treeRevealStore` exactly ONCE
// regardless of how many tree rows are on screen. The old per-TreeNode
// subscription scheme was the main reason reveal-in-tree contributed
// ~N writes per reveal, blowing past the <20 ms reveal budget in a 100k
// vault.
//
// We spy on treeRevealStore.subscribe to count registrations after the
// Sidebar mounts with a sizable tree.

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

function md(i: number): DirEntry {
  return {
    name: `note-${i}.md`,
    path: `${VAULT}/note-${i}.md`,
    is_dir: false,
    is_symlink: false,
    is_md: true,
    modified: null,
    created: null,
  };
}

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

describe("Sidebar registers exactly one treeRevealStore subscription (#253)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("renders 100 rows but only subscribes to treeRevealStore once", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => md(i));
    (listDirectory as any).mockResolvedValue(entries);

    const subscribeSpy = vi.spyOn(treeRevealStore, "subscribe");

    const { container } = render(Sidebar, { props: makeProps() });

    // Drain microtasks for vault subscribe + listDirectory + flatten.
    for (let i = 0; i < 15; i += 1) {
      await Promise.resolve();
      await tick();
    }

    // At least one flat row rendered so the assertion is meaningful.
    const rows = container.querySelectorAll("[data-tree-row]");
    expect(rows.length).toBeGreaterThan(0);

    // The critical invariant: exactly one subscription registered no matter
    // how many rows are on screen. If any TreeRow (re)acquires its own
    // subscription this count spikes to ~row-count.
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });
});
