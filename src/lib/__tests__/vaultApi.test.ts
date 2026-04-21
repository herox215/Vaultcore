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

  it("folder.notes returns direct children", () => {
    const v = createVaultRoot(mkStores());
    const sub = v.folders.where((f) => f.path === "sub").first()!;
    const paths = sub.notes.select((n) => n.path).toArray();
    expect(paths).toEqual(["sub/b.md", "sub/c.md"]);
  });

  it("folder.notes includes nested descendants", () => {
    const v = createVaultRoot({
      ...mkStores(),
      readVault: () => ({
        name: "V",
        path: "/v",
        fileList: ["Done/a.md", "Done/sub/b.md", "Done/sub/deep/c.md", "Other/x.md"],
      }),
    });
    const done = v.folders.where((f) => f.path === "Done").first()!;
    const paths = done.notes.select((n) => n.path).toArray();
    expect(paths).toEqual(["Done/a.md", "Done/sub/b.md", "Done/sub/deep/c.md"]);
  });

  it("folder.notes is empty for a folder with no descendants", () => {
    // Nested-only fixture: top-level "empty" appears as a folder only because
    // it's a prefix of some path — so construct one that is truly leaf-less
    // by giving it only subfolder entries.
    const v = createVaultRoot({
      ...mkStores(),
      readVault: () => ({
        name: "V",
        path: "/v",
        fileList: ["Outer/Inner/a.md"],
      }),
    });
    // Sanity: Inner has a note, Outer has it transitively.
    const inner = v.folders.where((f) => f.path === "Outer/Inner").first()!;
    expect(inner.notes.count()).toBe(1);
    const outer = v.folders.where((f) => f.path === "Outer").first()!;
    expect(outer.notes.count()).toBe(1);
    // A sibling prefix that isn't actually present yields nothing — and the
    // folders collection itself doesn't surface it, so this also checks that
    // `folder.notes` never leaks across sibling boundaries (e.g. "Out" must
    // not match "Outer/...").
    expect(v.folders.any((f) => f.path === "Out")).toBe(false);
  });

  it("folder.notes does not leak across sibling folders with shared prefix", () => {
    const v = createVaultRoot({
      ...mkStores(),
      readVault: () => ({
        name: "V",
        path: "/v",
        fileList: ["foo/a.md", "foobar/b.md"],
      }),
    });
    const foo = v.folders.where((f) => f.path === "foo").first()!;
    const paths = foo.notes.select((n) => n.path).toArray();
    expect(paths).toEqual(["foo/a.md"]);
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

// #319: Regression — the original bug was that `n.content.contains(...)` only
// considered the active editor tab. A `readNoteContent` that returns content
// for every note must let the filter match all of them.
describe("createVaultRoot — content-based filtering across all notes (#319)", () => {
  it("where(n => n.content.contains(...)) matches non-active notes", () => {
    const bodies: Record<string, string> = {
      "a.md": "nothing here",
      "sub/b.md": "mentions Maestro somewhere",
      "sub/c.md": "also Maestro in this one",
    };
    const v = createVaultRoot(
      mkStores({
        readNoteContent: (p) => bodies[p] ?? null,
      }),
    );
    const hits = v.notes
      .where((n) => n.content.includes("Maestro"))
      .select((n) => n.path)
      .toArray();
    expect(hits).toEqual(["sub/b.md", "sub/c.md"]);
  });
});

// #325: template bodies in a note's own text must NOT contribute to `.content`
// searches, otherwise a template like
// `{{vault.notes.where(n => n.content.contains("todo"))}}` matches the host
// note itself because the literal "todo" appears inside the expression body.
describe("createVaultRoot — n.content strips `{{ ... }}` regions (#325)", () => {
  it("a template body literal does not make the host note match itself", () => {
    const bodies: Record<string, string> = {
      // Only contains "todo" inside a template expression body.
      "a.md": "# Index\n\n{{vault.notes.where(n => n.content.contains(\"todo\")).select(f => f.name)}}\n",
      // Genuine prose mention — this is the note the filter should return.
      "sub/b.md": "- todo: call the landlord\n",
      // No mention at all.
      "sub/c.md": "unrelated content\n",
    };
    const v = createVaultRoot(
      mkStores({
        readNoteContent: (p) => bodies[p] ?? null,
      }),
    );
    const hits = v.notes
      .where((n) => n.content.includes("todo"))
      .select((n) => n.path)
      .toArray();
    expect(hits).toEqual(["sub/b.md"]);
  });

  it("strips every `{{ ... }}` region, including multi-line template bodies", () => {
    const bodies: Record<string, string> = {
      "a.md":
        "prefix {{ line1;\nline2 }} middle {{ another }} suffix\n",
    };
    const v = createVaultRoot(
      mkStores({
        readNoteContent: (p) => bodies[p] ?? null,
      }),
    );
    const content = v.notes.first()!.content;
    expect(content).not.toContain("line1");
    expect(content).not.toContain("line2");
    expect(content).not.toContain("another");
    expect(content).toContain("prefix");
    expect(content).toContain("middle");
    expect(content).toContain("suffix");
  });

  it("does not strip the second user-report shape — table-prefixed template", () => {
    // The template concatenates a table header string with a notes query.
    // The `"todo"` literal sits inside the expression body and must not
    // make the host note self-match.
    const bodies: Record<string, string> = {
      "a.md":
        "{{(\"|test|test|\\n|-|-|\\n\"); vault.notes.where(n => n.content.contains(\"todo\")).select(f => \"|[[\" + f.name + \"]]|-|\").join(\"\\n\")}}\n",
      "sub/b.md": "- todo: call the landlord\n",
      "sub/c.md": "irrelevant",
    };
    const v = createVaultRoot(
      mkStores({
        readNoteContent: (p) => bodies[p] ?? null,
      }),
    );
    const hits = v.notes
      .where((n) => n.content.includes("todo"))
      .select((n) => n.path)
      .toArray();
    expect(hits).toEqual(["sub/b.md"]);
  });

  it("strips adjacent expressions without leaving a fragment between them", () => {
    // Guards the `g`-flag contract: consecutive `{{ a }}{{ b }}` match as
    // two separate regions. A regex bug that folded them into one "greedy"
    // match, or skipped the second, would leave stray text behind.
    const bodies: Record<string, string> = {
      "a.md": "start {{ a }}{{ b }} end\n",
    };
    const v = createVaultRoot(
      mkStores({
        readNoteContent: (p) => bodies[p] ?? null,
      }),
    );
    const content = v.notes.first()!.content;
    expect(content).toBe("start  end\n");
  });

  it("frontmatter parsing is unaffected by the strip (uses raw content)", () => {
    // Frontmatter must see the verbatim file so YAML parses correctly even
    // when a `{{ ... }}` region lives in the body below it.
    const bodies: Record<string, string> = {
      "a.md":
        "---\ntitle: Hello\ntags: [one]\n---\n\n{{ vault.notes.count() }}\n",
    };
    const v = createVaultRoot(
      mkStores({
        readNoteContent: (p) => bodies[p] ?? null,
      }),
    );
    const a = v.notes.first()!;
    expect(a.property.title).toBe("Hello");
    expect(a.property.tags).toEqual(["one"]);
    // And `.content` on the same note still has the template stripped.
    expect(a.content).not.toContain("vault.notes.count()");
  });
});
