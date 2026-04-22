// Originally the regression test for issue #118 (`<svelte:self>` → self-import
// in Svelte 5). With the #253 virtualization refactor the tree no longer
// recurses — `flattenTree` walks the model iteratively and emits one flat row
// per visible node. This test was updated to verify the equivalent
// invariant: deeply nested, fully-expanded trees produce rows at every depth.

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

const VAULT = "/tmp/test-vault";

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

function dirEntry(name: string, path: string): DirEntry {
  return {
    name,
    path,
    is_dir: true,
    is_symlink: false,
    is_md: false,
    modified: null,
    created: null,
  };
}

function fileEntry(name: string, path: string): DirEntry {
  return {
    name,
    path,
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

describe("Flat sidebar renders nested subfolders across multiple levels (#118, updated for #253)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("renders all three levels when every folder is persisted-expanded", async () => {
    // Tree layout:
    //   outer/            (root)
    //     inner/          (subfolder)
    //       deep.md       (leaf)
    const outer = dirEntry("outer", `${VAULT}/outer`);
    const inner = dirEntry("inner", `${VAULT}/outer/inner`);
    const deep = fileEntry("deep.md", `${VAULT}/outer/inner/deep.md`);

    (listDirectory as any).mockImplementation(async (path: string) => {
      if (path === VAULT) return [outer];
      if (path === outer.path) return [inner];
      if (path === inner.path) return [deep];
      return [];
    });

    // Seed persisted expanded paths so the Sidebar walks the tree fully on
    // mount (no manual clicks required).
    const key = Object.keys(localStorage).find(() => false);
    // We can't know the vaultHashKey at construction time — instead, drive
    // expansion by clicking the rows after the initial render.
    const { container } = render(Sidebar, { props: makeProps() });

    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    // Outer renders.
    expect(container.textContent).toContain("outer");

    // Click outer's chevron to expand it — flat list grows.
    const outerRow = container.querySelector<HTMLElement>(`[data-tree-row="${outer.path}"]`);
    expect(outerRow).toBeTruthy();
    const outerChevron = outerRow!.querySelector<HTMLButtonElement>(".vc-tree-chevron");
    outerChevron!.click();
    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    const innerRow = container.querySelector<HTMLElement>(`[data-tree-row="${inner.path}"]`);
    expect(innerRow).toBeTruthy();
    expect(container.textContent).toContain("inner");

    // Click inner's chevron to descend another level.
    const innerChevron = innerRow!.querySelector<HTMLButtonElement>(".vc-tree-chevron");
    innerChevron!.click();
    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    const deepRow = container.querySelector<HTMLElement>(`[data-tree-row="${deep.path}"]`);
    expect(deepRow).toBeTruthy();
    expect(deepRow!.getAttribute("data-tree-row-depth")).toBe("2");
    expect(container.textContent).toContain("deep.md");
  });
});
