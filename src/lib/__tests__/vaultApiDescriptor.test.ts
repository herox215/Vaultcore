// Pins the descriptor tree in vaultApiDescriptor.ts to the runtime shape of
// the vault API (#284 acceptance: "Adding a new method or property to the
// vault API automatically shows up in completion with no extra wiring").
//
// These tests fail whenever the two drift — e.g. a new property on the vault
// root that isn't registered with the descriptor, or a Collection method that
// doesn't exist at runtime. The pin is deliberately one-way: new descriptor
// entries are fine, but every descriptor entry must have a runtime counterpart.

import { describe, it, expect } from "vitest";
import { createVaultRoot } from "../vaultApi";
import type { VaultStores } from "../vaultApi";
import { Collection } from "../queryCollection";
import {
  TYPES,
  membersOf,
} from "../vaultApiDescriptor";

function mkStores(): VaultStores {
  return {
    readVault: () => ({ name: "V", path: "/v", fileList: ["a.md"] }),
    readTags: () => [{ tag: "#x", count: 1 }],
    readBookmarks: () => [],
    readNoteContent: () => null,
  };
}

describe("descriptor ↔ runtime alignment", () => {
  it("Vault has the descriptor members present on the runtime root", () => {
    const v = createVaultRoot(mkStores()) as unknown as Record<string, unknown>;
    for (const m of TYPES.Vault!.members) {
      expect(v[m.name]).toBeDefined();
    }
  });

  it("Note has the descriptor members present on a runtime Note", () => {
    const v = createVaultRoot(mkStores());
    const note = v.notes.first()!;
    const rec = note as unknown as Record<string, unknown>;
    for (const m of TYPES.Note!.members) {
      expect(rec[m.name]).toBeDefined();
    }
  });

  it("Folder has the descriptor members present on a runtime Folder", () => {
    const stores: VaultStores = {
      ...mkStores(),
      readVault: () => ({ name: "V", path: "/v", fileList: ["a/b.md"] }),
    };
    const v = createVaultRoot(stores);
    const folder = v.folders.first()!;
    const rec = folder as unknown as Record<string, unknown>;
    for (const m of TYPES.Folder!.members) {
      expect(rec[m.name]).toBeDefined();
    }
  });

  it("Tag has the descriptor members present on a runtime Tag", () => {
    const v = createVaultRoot(mkStores());
    const tag = v.tags.first()!;
    const rec = tag as unknown as Record<string, unknown>;
    for (const m of TYPES.Tag!.members) {
      expect(rec[m.name]).toBeDefined();
    }
  });

  it("Collection<T> descriptor methods all exist on Collection.prototype", () => {
    const proto = Collection.prototype as unknown as Record<string, unknown>;
    for (const m of TYPES["Collection<T>"]!.members) {
      expect(typeof proto[m.name]).toBe("function");
    }
  });
});

describe("membersOf — parametric Collection<T>", () => {
  it("substitutes T with Note for Collection<Note>.first", () => {
    const ms = membersOf("Collection<Note>");
    const first = ms.find((m) => m.name === "first");
    expect(first?.returns).toBe("Note");
  });

  it("preserves Collection<T> return type for chainable methods", () => {
    const ms = membersOf("Collection<Note>");
    const where = ms.find((m) => m.name === "where");
    expect(where?.returns).toBe("Collection<Note>");
    expect(where?.lambdaParam).toBe("Note");
  });

  it("returns empty list for NoteProperties without dynamic keys", () => {
    expect(membersOf("NoteProperties")).toEqual([]);
  });

  it("materializes NoteProperties members from the dynamic key list", () => {
    const ms = membersOf("NoteProperties", ["title", "tags"]);
    expect(ms.map((m) => m.name)).toEqual(["title", "tags"]);
    expect(ms[0]!.kind).toBe("property");
  });
});
