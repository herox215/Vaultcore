// Regression test for issue #116: `initiallyExpanded` is a one-shot seed
// for the local `expanded` $state. The Svelte 5 fix wraps the seed in
// `untrack(() => initiallyExpanded)` to silence the reactivity warning
// while preserving the original behaviour — the prop should drive the
// initial `aria-expanded` state but should not be re-read when the
// parent later mutates the expanded-paths list.

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
}));

import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { tabStore } from "../../../store/tabStore";
import TreeNode from "../TreeNode.svelte";
import type { DirEntry } from "../../../types/tree";

const VAULT = "/tmp/test-vault";

function dirEntry(overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name: "folder",
    path: `${VAULT}/folder`,
    is_dir: true,
    is_symlink: false,
    is_md: false,
    modified: null,
    created: null,
    ...overrides,
  };
}

function makeProps(entry: DirEntry, initiallyExpanded: boolean) {
  return {
    entry,
    depth: 0,
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onRefreshParent: vi.fn(),
    onPathChanged: vi.fn(),
    initiallyExpanded,
  };
}

describe("TreeNode seeds `expanded` from `initiallyExpanded` prop (#116)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    tabStore._reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("renders aria-expanded=\"true\" when initiallyExpanded is true", async () => {
    const { container } = render(TreeNode, { props: makeProps(dirEntry(), true) });
    await tick();
    const nodeEl = container.querySelector(".vc-tree-node") as HTMLElement;
    expect(nodeEl.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders aria-expanded=\"false\" when initiallyExpanded is false", async () => {
    const { container } = render(TreeNode, { props: makeProps(dirEntry(), false) });
    await tick();
    const nodeEl = container.querySelector(".vc-tree-node") as HTMLElement;
    expect(nodeEl.getAttribute("aria-expanded")).toBe("false");
  });
});
