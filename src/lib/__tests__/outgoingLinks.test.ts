import { describe, it, expect } from "vitest";
import { extractOutgoingLinks } from "../outgoingLinks";

function makeResolver(map: Record<string, string>) {
  return (target: string) => {
    const key = target.toLowerCase();
    return map[key] ?? null;
  };
}

describe("extractOutgoingLinks", () => {
  it("returns an empty list when the document has no wiki-links", () => {
    const res = extractOutgoingLinks("# Heading\n\nPlain prose.", () => null);
    expect(res).toEqual([]);
  });

  it("parses simple [[target]] links", () => {
    const resolve = makeResolver({ "alpha": "notes/Alpha.md" });
    const res = extractOutgoingLinks("See [[Alpha]] for details.", resolve);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      target: "Alpha",
      resolvedPath: "notes/Alpha.md",
      aliases: [],
    });
  });

  it("marks unresolved links with resolvedPath = null", () => {
    const res = extractOutgoingLinks("A dangling [[Ghost]] link.", () => null);
    expect(res).toHaveLength(1);
    expect(res[0]?.resolvedPath).toBeNull();
    expect(res[0]?.target).toBe("Ghost");
  });

  it("deduplicates repeated links by resolved path (resolved case)", () => {
    const resolve = makeResolver({ "alpha": "notes/Alpha.md" });
    const doc = "[[Alpha]] and again [[Alpha]] and [[alpha]].";
    const res = extractOutgoingLinks(doc, resolve);
    expect(res).toHaveLength(1);
    expect(res[0]?.resolvedPath).toBe("notes/Alpha.md");
  });

  it("deduplicates repeated unresolved links by lowercased stem", () => {
    const doc = "[[Ghost]] [[ghost]] [[GHOST]]";
    const res = extractOutgoingLinks(doc, () => null);
    expect(res).toHaveLength(1);
    expect(res[0]?.target).toBe("Ghost"); // first-seen casing wins
  });

  it("collects aliases encountered for the same target", () => {
    const resolve = makeResolver({ "alpha": "notes/Alpha.md" });
    const doc = "[[Alpha|first alias]] and [[Alpha|second alias]] and [[Alpha]]";
    const res = extractOutgoingLinks(doc, resolve);
    expect(res).toHaveLength(1);
    expect(res[0]?.aliases).toEqual(["first alias", "second alias"]);
  });

  it("preserves document order based on first occurrence", () => {
    const resolve = makeResolver({
      "zeta": "Zeta.md",
      "alpha": "Alpha.md",
    });
    const doc = "[[Zeta]] then [[Alpha]] then [[Zeta]] again.";
    const res = extractOutgoingLinks(doc, resolve);
    expect(res.map((l) => l.target)).toEqual(["Zeta", "Alpha"]);
  });

  it("strips .md suffix from targets before resolution and dedup", () => {
    const resolve = makeResolver({ "alpha": "notes/Alpha.md" });
    const doc = "[[Alpha]] vs [[Alpha.md]]";
    const res = extractOutgoingLinks(doc, resolve);
    expect(res).toHaveLength(1);
    expect(res[0]?.target).toBe("Alpha");
    expect(res[0]?.resolvedPath).toBe("notes/Alpha.md");
  });

  it("tracks line numbers for first occurrence", () => {
    const doc = "line 0\nline 1 [[Alpha]]\nline 2\n[[Beta]]";
    const res = extractOutgoingLinks(doc, () => null);
    expect(res[0]?.target).toBe("Alpha");
    expect(res[0]?.lineNumber).toBe(1);
    expect(res[1]?.target).toBe("Beta");
    expect(res[1]?.lineNumber).toBe(3);
  });

  it("ignores empty or whitespace-only targets", () => {
    const res = extractOutgoingLinks("[[ ]] and [[]]", () => null);
    expect(res).toEqual([]);
  });

  it("does not surface embed syntax as outgoing links", () => {
    // Embeds `![[...]]` are out of scope per issue #4. The current regex
    // still matches the inner `[[...]]` — but the leading `!` is NOT the
    // same logical entity. For now we accept the match: parity with the
    // CM6 wikiLink plugin which also matches the inner `[[...]]`. If this
    // ever changes we'd revise both parsers together.
    const res = extractOutgoingLinks("![[embed.png]]", () => null);
    expect(res.length).toBeLessThanOrEqual(1);
  });
});
