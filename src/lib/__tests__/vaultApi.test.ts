// Unit tests for the vault expression API (#283).

import { describe, it, expect } from "vitest";
import { createVaultRoot } from "../vaultApi";
import type { VaultStores } from "../vaultApi";

function mkStores(overrides: Partial<VaultStores> = {}): VaultStores {
  return {
    readVault: () => ({
      name: "MyVault",
      path: "/vault/MyVault",
      fileList: ["a.md", "sub/b.md", "sub/c.md"],
    }),
    readTags: () => [
      { tag: "#idea", count: 3 },
      { tag: "#todo", count: 1 },
    ],
    readBookmarks: () => ["a.md"],
    readNoteContent: () => null,
    ...overrides,
  };
}

describe("createVaultRoot — scalar fields", () => {
  it("exposes name and path from the vault snapshot", () => {
    const v = createVaultRoot(mkStores());
    expect(v.name).toBe("MyVault");
    expect(v.path).toBe("/vault/MyVault");
  });

  it("re-reads the store on every getter access (live behaviour)", () => {
    let name = "A";
    const v = createVaultRoot(
      mkStores({
        readVault: () => ({ name, path: "/", fileList: [] }),
      }),
    );
    expect(v.name).toBe("A");
    name = "B";
    expect(v.name).toBe("B");
  });
});

describe("createVaultRoot — notes", () => {
  it("exposes notes as a Collection of Note objects with path/name/title", () => {
    const v = createVaultRoot(mkStores());
    const notes = v.notes.toArray();
    expect(notes).toHaveLength(3);
    expect(notes[0]!.path).toBe("a.md");
    expect(notes[0]!.name).toBe("a.md");
    expect(notes[0]!.title).toBe("a");
    expect(notes[1]!.path).toBe("sub/b.md");
    expect(notes[1]!.title).toBe("b");
  });

  it("notes.count() reflects file list size", () => {
    expect(createVaultRoot(mkStores()).notes.count()).toBe(3);
  });

  it("where/select chain over notes works", () => {
    const v = createVaultRoot(mkStores());
    const out = v.notes
      .where((n) => n.path.startsWith("sub/"))
      .select((n) => n.title)
      .toArray();
    expect(out).toEqual(["b", "c"]);
  });
});

describe("createVaultRoot — note.property proxy", () => {
  const stores = mkStores({
    readNoteContent: (path) => {
      if (path !== "a.md") return null;
      return "---\ntitle: Hello\ntags: [one, two]\n---\nbody text\n";
    },
  });

  it("exposes frontmatter keys that actually exist in the note", () => {
    const v = createVaultRoot(stores);
    const a = v.notes.first()!;
    expect(a.property.title).toBe("Hello");
    expect(a.property.tags).toEqual(["one", "two"]);
  });

  it("returns undefined for absent keys (not silent throw)", () => {
    const v = createVaultRoot(stores);
    const a = v.notes.first()!;
    expect(a.property.author).toBeUndefined();
  });

  it("notes without content expose an empty property bag", () => {
    const v = createVaultRoot(stores);
    const b = v.notes.toArray()[1]!;
    expect(b.property.anything).toBeUndefined();
  });

  it("ownKeys reflects the note's actual frontmatter", () => {
    const v = createVaultRoot(stores);
    const a = v.notes.first()!;
    expect(Object.keys(a.property)).toEqual(["title", "tags"]);
  });
});

describe("createVaultRoot — tags, bookmarks, folders, stats", () => {
  it("tags are exposed with name + count", () => {
    const v = createVaultRoot(mkStores());
    const tags = v.tags.toArray();
    expect(tags.map((t) => t.name)).toEqual(["#idea", "#todo"]);
    expect(tags[0]!.count).toBe(3);
  });

  it("bookmarks resolve to Note objects", () => {
    const v = createVaultRoot(mkStores());
    const bm = v.bookmarks.toArray();
    expect(bm).toHaveLength(1);
    expect(bm[0]!.path).toBe("a.md");
  });

  it("folders are derived from the file list", () => {
    const v = createVaultRoot(mkStores());
    const names = v.folders.select((f) => f.path).toArray();
    // Only `sub` is a folder (a.md is at the root).
    expect(names).toEqual(["sub"]);
  });

  it("stats exposes noteCount and tagCount", () => {
    const v = createVaultRoot(mkStores());
    expect(v.stats.noteCount).toBe(3);
    expect(v.stats.tagCount).toBe(2);
  });
});

describe("createVaultRoot — type tags for debug rendering", () => {
  it("vault carries __typeName", () => {
    const v = createVaultRoot(mkStores());
    expect((v as { __typeName: string }).__typeName).toBe("Vault");
  });

  it("note carries __typeName and __id", () => {
    const v = createVaultRoot(mkStores());
    const a = v.notes.first()!;
    expect(a.__typeName).toBe("Note");
    expect(a.__id).toBe("a.md");
  });
});
