// TDD for #253: flatten the sidebar tree model into a single array of rows.
// The virtualized renderer slices this array; the lazy-load contract matches
// what TreeNode.loadChildren did on its own — expanded folders whose children
// haven't been fetched yet contribute ONLY the folder row (no child rows).

import { describe, it, expect } from "vitest";
import {
  flattenTree,
  type FolderState,
  type TreeModel,
} from "../../../lib/flattenTree";
import type { DirEntry } from "../../../types/tree";

const VAULT = "/tmp/test-vault";

function dir(name: string, path: string): DirEntry {
  return { name, path, is_dir: true, is_symlink: false, is_md: false, modified: null, created: null };
}
function md(name: string, path: string): DirEntry {
  return { name, path, is_dir: false, is_symlink: false, is_md: true, modified: null, created: null };
}

function makeModel(args: {
  root: DirEntry[];
  folders?: Record<string, FolderState>;
  expanded?: string[];
}): TreeModel {
  return {
    vaultPath: VAULT,
    rootEntries: args.root,
    folders: new Map(Object.entries(args.folders ?? {})),
    expanded: new Set(args.expanded ?? []),
    sortBy: "name",
  };
}

describe("flattenTree (#253)", () => {
  it("emits only root rows when no folders are expanded", () => {
    const a = dir("alpha", `${VAULT}/alpha`);
    const b = md("b.md", `${VAULT}/b.md`);
    const model = makeModel({ root: [a, b] });

    const flat = flattenTree(model);
    expect(flat.map((r) => r.path)).toEqual([a.path, b.path]);
    expect(flat.every((r) => r.depth === 0)).toBe(true);
    expect(flat[0]!.expanded).toBe(false);
    expect(flat[0]!.hasRenderedChildren).toBe(false);
  });

  it("collapsed folders contribute no children even when children are loaded", () => {
    const a = dir("alpha", `${VAULT}/alpha`);
    const child = md("inner.md", `${VAULT}/alpha/inner.md`);
    const model = makeModel({
      root: [a],
      folders: {
        [a.path]: { children: [child], childrenLoaded: true, loading: false },
      },
      expanded: [], // NOT expanded — child must NOT appear
    });

    const flat = flattenTree(model);
    expect(flat.map((r) => r.path)).toEqual([a.path]);
  });

  it("expanded-but-not-loaded folders contribute the folder row but no children", () => {
    const a = dir("alpha", `${VAULT}/alpha`);
    const model = makeModel({
      root: [a],
      folders: {
        // No children fetched yet — mirrors the split second after the user
        // clicks the chevron and listDirectory is still in-flight.
        [a.path]: { children: undefined, childrenLoaded: false, loading: true },
      },
      expanded: ["alpha"],
    });

    const flat = flattenTree(model);
    expect(flat.map((r) => r.path)).toEqual([a.path]);
    expect(flat[0]!.expanded).toBe(true);
    expect(flat[0]!.loading).toBe(true);
    expect(flat[0]!.childrenLoaded).toBe(false);
  });

  it("expanded+loaded folders emit children with correct depth", () => {
    const a = dir("alpha", `${VAULT}/alpha`);
    const innerDir = dir("nested", `${VAULT}/alpha/nested`);
    const deep = md("deep.md", `${VAULT}/alpha/nested/deep.md`);
    const sibling = md("sibling.md", `${VAULT}/alpha/sibling.md`);

    const model = makeModel({
      root: [a],
      folders: {
        [a.path]: { children: [innerDir, sibling], childrenLoaded: true, loading: false },
        [innerDir.path]: { children: [deep], childrenLoaded: true, loading: false },
      },
      expanded: ["alpha", "alpha/nested"],
    });

    const flat = flattenTree(model);
    // Folders first, then files (sortEntries behaviour).
    expect(flat.map((r) => r.name)).toEqual(["alpha", "nested", "deep.md", "sibling.md"]);
    expect(flat.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
  });

  it("stops descending into an expanded folder whose children are still loading", () => {
    const a = dir("alpha", `${VAULT}/alpha`);
    const inner = dir("inner", `${VAULT}/alpha/inner`);
    const deep = md("deep.md", `${VAULT}/alpha/inner/deep.md`);

    // alpha is expanded+loaded; inner is expanded but NOT loaded yet. The
    // flat model must emit [alpha, inner] and NOT descend into inner's
    // unloaded children — confirming we preserve the lazy-load contract.
    const model = makeModel({
      root: [a],
      folders: {
        [a.path]: { children: [inner], childrenLoaded: true, loading: false },
        [inner.path]: { children: undefined, childrenLoaded: false, loading: true },
      },
      expanded: ["alpha", "alpha/inner"],
    });

    const flat = flattenTree(model);
    expect(flat.map((r) => r.name)).toEqual(["alpha", "inner"]);
    expect(flat.find((r) => r.name === "inner")!.loading).toBe(true);
    // deep.md must NOT be in the flat list.
    expect(flat.find((r) => r.name === "deep.md")).toBeUndefined();
  });

  it("handles a deeply nested expanded chain without skipping levels", () => {
    const l0 = dir("l0", `${VAULT}/l0`);
    const l1 = dir("l1", `${VAULT}/l0/l1`);
    const l2 = dir("l2", `${VAULT}/l0/l1/l2`);
    const leaf = md("leaf.md", `${VAULT}/l0/l1/l2/leaf.md`);

    const model = makeModel({
      root: [l0],
      folders: {
        [l0.path]: { children: [l1], childrenLoaded: true, loading: false },
        [l1.path]: { children: [l2], childrenLoaded: true, loading: false },
        [l2.path]: { children: [leaf], childrenLoaded: true, loading: false },
      },
      expanded: ["l0", "l0/l1", "l0/l1/l2"],
    });

    const flat = flattenTree(model);
    expect(flat.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
    expect(flat.map((r) => r.name)).toEqual(["l0", "l1", "l2", "leaf.md"]);
  });
});
