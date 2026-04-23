// #345 — regression guard for the encryption-aware flatten behavior:
// a locked folder must not emit any child rows even when expanded,
// and row.encryption must reflect the backend field for both locked
// and unlocked states.

import { describe, it, expect } from "vitest";

import { flattenTree, type TreeModel } from "../flattenTree";
import type { DirEntry } from "../../types/tree";

function entry(overrides: Partial<DirEntry>): DirEntry {
  return {
    name: overrides.name ?? "entry",
    path: overrides.path ?? "/vault/entry",
    is_dir: overrides.is_dir ?? true,
    is_symlink: false,
    is_md: overrides.is_md ?? false,
    modified: null,
    created: null,
    encryption: overrides.encryption ?? "not-encrypted",
  };
}

describe("flattenTree — #345 encryption", () => {
  it("does not emit children for a locked folder even if expanded", () => {
    const lockedFolder = entry({
      name: "secret",
      path: "/vault/secret",
      encryption: "locked",
    });
    const child = entry({
      name: "leaked.md",
      path: "/vault/secret/leaked.md",
      is_dir: false,
      is_md: true,
    });
    const model: TreeModel = {
      vaultPath: "/vault",
      rootEntries: [lockedFolder],
      folders: new Map([
        ["/vault/secret", { children: [child], childrenLoaded: true, loading: false }],
      ]),
      // Even if the locked folder is in the expanded set (would happen
      // if the user expanded it before locking), flatten must drop it.
      expanded: new Set(["secret"]),
      sortBy: "name",
    };
    const rows = flattenTree(model);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("secret");
    expect(rows[0]!.encryption).toBe("locked");
  });

  it("emits children for an unlocked encrypted folder", () => {
    const unlockedFolder = entry({
      name: "journal",
      path: "/vault/journal",
      encryption: "unlocked",
    });
    const child = entry({
      name: "2026.md",
      path: "/vault/journal/2026.md",
      is_dir: false,
      is_md: true,
    });
    const model: TreeModel = {
      vaultPath: "/vault",
      rootEntries: [unlockedFolder],
      folders: new Map([
        ["/vault/journal", { children: [child], childrenLoaded: true, loading: false }],
      ]),
      expanded: new Set(["journal"]),
      sortBy: "name",
    };
    const rows = flattenTree(model);
    expect(rows.map((r) => r.name)).toEqual(["journal", "2026.md"]);
    expect(rows[0]!.encryption).toBe("unlocked");
  });

  it("defaults missing encryption to 'not-encrypted'", () => {
    const plain = {
      name: "plain",
      path: "/vault/plain",
      is_dir: true,
      is_symlink: false,
      is_md: false,
      modified: null,
      created: null,
    } as DirEntry;
    const model: TreeModel = {
      vaultPath: "/vault",
      rootEntries: [plain],
      folders: new Map(),
      expanded: new Set(),
      sortBy: "name",
    };
    const rows = flattenTree(model);
    expect(rows[0]!.encryption).toBe("not-encrypted");
  });
});
