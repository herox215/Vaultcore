// Regression test for issue #118: `<svelte:self>` was replaced with a
// self-import in Svelte 5. The recursive tree must still render nested
// subfolders correctly — otherwise the entire tree collapses to a single
// level without any build/runtime warning.

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
}));

import { listDirectory } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import TreeNode from "../TreeNode.svelte";
import type { DirEntry } from "../../../types/tree";

const VAULT = "/tmp/test-vault";

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

describe("TreeNode recursion (#118)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("renders nested subfolders across multiple levels via self-import", async () => {
    // Tree layout:
    //   outer/            (root, rendered via TreeNode)
    //     inner/          (subfolder, must render via recursive self-import)
    //       deep.md       (leaf in the nested subfolder)
    const outer = dirEntry("outer", `${VAULT}/outer`);
    const inner = dirEntry("inner", `${VAULT}/outer/inner`);
    const deep = fileEntry("deep.md", `${VAULT}/outer/inner/deep.md`);

    // Children of outer -> [inner]; children of inner -> [deep].
    (listDirectory as any).mockImplementation(async (path: string) => {
      if (path === outer.path) return [inner];
      if (path === inner.path) return [deep];
      return [];
    });

    const { container } = render(TreeNode, {
      props: {
        entry: outer,
        depth: 0,
        selectedPath: null,
        onSelect: vi.fn(),
        onOpenFile: vi.fn(),
        onRefreshParent: vi.fn(),
        onPathChanged: vi.fn(),
        initiallyExpanded: true,
        // Persisted-expanded paths — relative to vault root — so the nested
        // `inner` folder auto-expands on mount and its child becomes visible.
        expandedPaths: ["outer/inner"],
      },
    });

    // Allow onMount + nested loadChildren to settle. Multiple ticks needed
    // because each recursion level mounts asynchronously.
    for (let i = 0; i < 6; i++) await tick();

    // Outer folder row is rendered.
    expect(container.textContent).toContain("outer");

    // Inner folder row — rendered via the recursive TreeNode self-import.
    // If `<TreeNode>` (ex `<svelte:self>`) did not recurse, "inner" would be
    // absent from the DOM.
    expect(container.textContent).toContain("inner");

    // Leaf two levels deep — confirms recursion descended past level 1.
    expect(container.textContent).toContain("deep.md");

    // There must be at least two tree-children groups nested inside one
    // another (outer > inner), proving the recursion structurally.
    const groups = container.querySelectorAll("ul.vc-tree-children");
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });
});
