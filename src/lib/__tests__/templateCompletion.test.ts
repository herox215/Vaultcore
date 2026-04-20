// Unit tests for the template-expression completion engine (#284).

import { describe, it, expect } from "vitest";
import {
  analyzeCompletion,
  resolveExpressionType,
} from "../templateCompletion";

describe("analyzeCompletion — root scope", () => {
  it("suggests `vault` on an empty expression", () => {
    const a = analyzeCompletion("");
    expect(a.items.map((i) => i.label)).toEqual(["vault"]);
    expect(a.prefix).toBe("");
    expect(a.from).toBe(0);
  });

  it("filters root scope by the current prefix", () => {
    const a = analyzeCompletion("vau");
    expect(a.items.map((i) => i.label)).toEqual(["vault"]);
    expect(a.prefix).toBe("vau");
    expect(a.from).toBe(0);
  });

  it("returns an empty list when the prefix doesn't match anything", () => {
    const a = analyzeCompletion("xyz");
    expect(a.items).toEqual([]);
  });
});

describe("analyzeCompletion — Vault members", () => {
  it("lists Vault members after `vault.`", () => {
    const a = analyzeCompletion("vault.");
    const labels = a.items.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "name", "path", "notes", "folders", "tags", "bookmarks", "stats",
      ]),
    );
    expect(a.from).toBe(6);
  });

  it("filters Vault members by prefix", () => {
    const a = analyzeCompletion("vault.no");
    expect(a.items.map((i) => i.label)).toEqual(["notes"]);
    expect(a.prefix).toBe("no");
    expect(a.from).toBe(6);
  });
});

describe("analyzeCompletion — Collection<Note> methods", () => {
  it("lists collection methods after `vault.notes.`", () => {
    const a = analyzeCompletion("vault.notes.");
    const labels = a.items.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "where", "select", "count", "first", "take", "skip",
        "sortBy", "distinct", "any", "all", "groupBy", "toArray",
      ]),
    );
  });

  it("insertText for methods appends `(`", () => {
    const a = analyzeCompletion("vault.notes.wh");
    const where = a.items.find((i) => i.label === "where");
    expect(where?.insertText).toBe("where(");
    expect(where?.kind).toBe("method");
  });

  it("reports concrete Collection<Note> return types", () => {
    const a = analyzeCompletion("vault.notes.");
    const whereItem = a.items.find((i) => i.label === "where");
    expect(whereItem?.detail).toBe("Collection<Note>");
    const firstItem = a.items.find((i) => i.label === "first");
    expect(firstItem?.detail).toBe("Note");
  });
});

describe("analyzeCompletion — after method calls", () => {
  it("completes on Note after `vault.notes.first().`", () => {
    const a = analyzeCompletion("vault.notes.first().");
    const labels = a.items.map((i) => i.label).sort();
    expect(labels).toEqual(
      ["content", "name", "path", "property", "title"].sort(),
    );
  });

  it("completes on Collection<Note> after `.where(...).`", () => {
    const a = analyzeCompletion("vault.notes.where(n => n.name == 'a').");
    const labels = a.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["where", "count", "first"]));
  });
});

describe("analyzeCompletion — inside lambda body", () => {
  it("binds the lambda param to the collection's element type", () => {
    const a = analyzeCompletion("vault.notes.where(n => n.");
    const labels = a.items.map((i) => i.label).sort();
    expect(labels).toEqual(
      ["content", "name", "path", "property", "title"].sort(),
    );
  });

  it("handles parenthesised `(x) => x.` single-param arrow", () => {
    const a = analyzeCompletion("vault.notes.select((x) => x.");
    expect(a.items.map((i) => i.label)).toEqual(
      expect.arrayContaining(["name", "path", "title"]),
    );
  });

  it("scopes the lambda param so outer names still resolve after `)`", () => {
    const a = analyzeCompletion("vault.notes.where(n => n.name == 'x').");
    expect(a.items.map((i) => i.label)).toEqual(
      expect.arrayContaining(["count", "where"]),
    );
  });
});

describe("analyzeCompletion — NoteProperties (dynamic frontmatter)", () => {
  it("uses the provided frontmatter keys after `.property.`", () => {
    const a = analyzeCompletion("vault.notes.first().property.", {
      dynamicFrontmatterKeys: ["title", "tags", "author"],
    });
    expect(a.items.map((i) => i.label)).toEqual(["title", "tags", "author"]);
  });

  it("filters frontmatter keys by prefix", () => {
    const a = analyzeCompletion("vault.notes.first().property.ta", {
      dynamicFrontmatterKeys: ["title", "tags", "author"],
    });
    expect(a.items.map((i) => i.label)).toEqual(["tags"]);
  });

  it("returns an empty list when no keys are provided", () => {
    const a = analyzeCompletion("vault.notes.first().property.");
    expect(a.items).toEqual([]);
  });
});

describe("analyzeCompletion — non-completion positions", () => {
  it("suggests root scope inside arithmetic contexts", () => {
    const a = analyzeCompletion("1 + v");
    expect(a.items.map((i) => i.label)).toEqual(["vault"]);
  });

  it("does not crash on unclosed parentheses", () => {
    // Broken input — the engine should still compute something useful
    // (Collection<Note> members) rather than throw.
    expect(() => analyzeCompletion("vault.notes.where(n => n.")).not.toThrow();
  });
});

describe("resolveExpressionType", () => {
  it("resolves simple root access", () => {
    expect(resolveExpressionType("vault")).toBe("Vault");
  });

  it("resolves member chains", () => {
    expect(resolveExpressionType("vault.notes")).toBe("Collection<Note>");
    expect(resolveExpressionType("vault.stats")).toBe("VaultStats");
  });

  it("resolves method return types", () => {
    expect(resolveExpressionType("vault.notes.first()")).toBe("Note");
    expect(resolveExpressionType("vault.notes.count()")).toBe("number");
  });

  it("returns null for unknown members", () => {
    expect(resolveExpressionType("vault.nonsense")).toBeNull();
  });

  it("returns null for unknown identifiers", () => {
    expect(resolveExpressionType("foo.bar")).toBeNull();
  });
});
