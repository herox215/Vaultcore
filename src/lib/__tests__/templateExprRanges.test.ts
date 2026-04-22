// Unit tests for the shared template-expression range helper (#295).

import { describe, it, expect } from "vitest";
import {
  findTemplateExprRanges,
  isInsideTemplateExpr,
} from "../templateExprRanges";

describe("findTemplateExprRanges", () => {
  it("returns empty when the text contains no expression", () => {
    expect(findTemplateExprRanges("just some prose")).toEqual([]);
  });

  it("finds a single-line expression", () => {
    const text = "before {{vault.name}} after";
    const [first] = findTemplateExprRanges(text);
    expect(first).toBeDefined();
    const [from, to] = first!;
    expect(text.slice(from, to)).toBe("{{vault.name}}");
  });

  it("finds multiple expressions in document order", () => {
    const text = "{{a}} then {{b}} then {{c}}";
    const ranges = findTemplateExprRanges(text);
    expect(ranges).toHaveLength(3);
    expect(ranges[0]![0]).toBeLessThan(ranges[1]![0]);
    expect(ranges[1]![0]).toBeLessThan(ranges[2]![0]);
  });

  it("supports multi-line expression bodies", () => {
    const text = "prose\n{{vault.notes\n.count()}}\ntail";
    const ranges = findTemplateExprRanges(text);
    expect(ranges).toHaveLength(1);
    const [from, to] = ranges[0]!;
    expect(text.slice(from, to)).toBe("{{vault.notes\n.count()}}");
  });

  it("does not match unbalanced or nested braces", () => {
    // `{{ { }}` — inner `{` is excluded by the `[^{}]` class, so the regex
    // finds no complete match.
    expect(findTemplateExprRanges("{{ { }}")).toEqual([]);
    // Lone braces round-trip fine.
    expect(findTemplateExprRanges("just { and }")).toEqual([]);
  });

  it("offsets positions by baseOffset so callers can pass viewport slices", () => {
    const full = "lorem ipsum {{vault.name}} dolor";
    const sliceFrom = 6;
    const slice = full.slice(sliceFrom); // "ipsum {{vault.name}} dolor"
    const ranges = findTemplateExprRanges(slice, sliceFrom);
    expect(ranges).toHaveLength(1);
    const [from, to] = ranges[0]!;
    // Coordinates are in the *original* document frame.
    expect(full.slice(from, to)).toBe("{{vault.name}}");
  });
});

describe("isInsideTemplateExpr", () => {
  const ranges = findTemplateExprRanges("aa {{X}} bb {{YY}} cc");
  // Ranges are roughly [3,8) and [12,18) — computed dynamically so the test
  // does not encode magic offsets.

  it("returns true for a zero-length probe inside an expression", () => {
    const [a] = ranges[0]!;
    expect(isInsideTemplateExpr(ranges, a + 1)).toBe(true);
  });

  it("returns false outside any expression range", () => {
    expect(isInsideTemplateExpr(ranges, 0)).toBe(false);
    expect(isInsideTemplateExpr(ranges, 20)).toBe(false);
  });

  it("returns true when a match range overlaps the start of an expression", () => {
    const [from] = ranges[0]!;
    // Match span [from-1, from+2) straddles the opening `{{`.
    expect(isInsideTemplateExpr(ranges, from - 1, from + 2)).toBe(true);
  });

  it("returns false for a match that ends exactly at the expression's start", () => {
    // Half-open semantics: [x, from) does NOT overlap [from, to).
    const [from] = ranges[0]!;
    expect(isInsideTemplateExpr(ranges, 0, from)).toBe(false);
  });

  it("returns false for an empty range list", () => {
    expect(isInsideTemplateExpr([], 5, 10)).toBe(false);
  });

  it("returns true when probe spans multiple expressions", () => {
    // A match that straddles the whole doc obviously overlaps both.
    expect(isInsideTemplateExpr(ranges, 0, 100)).toBe(true);
  });
});
