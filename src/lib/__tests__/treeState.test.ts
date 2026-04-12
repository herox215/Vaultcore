/**
 * treeState tests — sortEntries algorithm, persistence round-trip, vault hash key.
 * FILE-06: sort order (name / modified / created) with folders-first.
 * FILE-07: per-vault localStorage persistence.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import {
  sortEntries,
  loadTreeState,
  saveTreeState,
  vaultHashKey,
  DEFAULT_TREE_STATE,
} from "../treeState";
import type { DirEntry } from "../../types/tree";

/** Create a fresh in-memory localStorage mock and stub it globally. */
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

beforeEach(() => {
  vi.stubGlobal("localStorage", makeLocalStorage());
});

function entry(
  name: string,
  is_dir: boolean,
  modified: number | null = null,
  created: number | null = null
): DirEntry {
  return {
    name,
    path: `/v/${name}`,
    is_dir,
    is_symlink: false,
    is_md: !is_dir,
    modified,
    created,
  };
}

describe("treeState.sortEntries (FILE-06)", () => {
  it("Test 1: folders before files, alpha within each group for sortBy=name", () => {
    const input = [
      entry("bbb.md", false),
      entry("AAA", true),
      entry("aaa.md", false),
      entry("ZZZ", true),
    ];
    const out = sortEntries(input, "name").map((e) => e.name);
    expect(out).toEqual(["AAA", "ZZZ", "aaa.md", "bbb.md"]);
  });

  it("Test 2: sortBy=modified orders files DESC by modified; folders stay alpha", () => {
    const input = [
      entry("old.md", false, 1000),
      entry("new.md", false, 3000),
      entry("Zdir", true),
      entry("Adir", true),
    ];
    const out = sortEntries(input, "modified").map((e) => e.name);
    expect(out).toEqual(["Adir", "Zdir", "new.md", "old.md"]);
  });

  it("Test 3: sortBy=created: nulls sort last", () => {
    const input = [
      entry("has.md", false, null, 5000),
      entry("null.md", false, null, null),
      entry("old.md", false, null, 1000),
    ];
    const out = sortEntries(input, "created").map((e) => e.name);
    expect(out).toEqual(["has.md", "old.md", "null.md"]);
  });
});

describe("treeState persistence (FILE-07)", () => {
  it("Test 4: vaultHashKey is deterministic and prefixed", async () => {
    const a = await vaultHashKey("/same");
    const b = await vaultHashKey("/same");
    const c = await vaultHashKey("/other");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("vaultcore-tree-state:")).toBe(true);
    expect(a.length).toBe("vaultcore-tree-state:".length + 16);
  });

  it("Test 5: round-trips a saved state", async () => {
    const state = {
      sortBy: "modified" as const,
      expanded: ["notes", "notes/daily"],
    };
    await saveTreeState("/v", state);
    const loaded = await loadTreeState("/v");
    expect(loaded).toEqual(state);
  });

  it("Test 6: returns default for unknown vault", async () => {
    const loaded = await loadTreeState("/never-saved");
    expect(loaded).toEqual(DEFAULT_TREE_STATE);
  });

  it("Test 7: returns default on corrupted JSON", async () => {
    const key = await vaultHashKey("/v");
    localStorage.setItem(key, "{not json");
    const loaded = await loadTreeState("/v");
    expect(loaded).toEqual(DEFAULT_TREE_STATE);
  });
});
