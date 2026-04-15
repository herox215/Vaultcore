import { describe, it, expect } from "vitest";
import { fuzzyMatch } from "../fuzzy";

describe("fuzzyMatch", () => {
  it("returns score 0 for empty query", () => {
    expect(fuzzyMatch("anything", "")).toEqual({ score: 0, matchIndices: [] });
  });

  it("returns null when query chars cannot be found in order", () => {
    expect(fuzzyMatch("abc", "cba")).toBeNull();
    expect(fuzzyMatch("abc", "z")).toBeNull();
  });

  it("returns match indices in order for subsequence hits", () => {
    const m = fuzzyMatch("New Note", "nt");
    expect(m).not.toBeNull();
    expect(m!.matchIndices).toEqual([0, 6]);
  });

  it("scores consecutive matches higher than scattered", () => {
    const a = fuzzyMatch("Close Tab", "tab")!;
    const b = fuzzyMatch("Toggle Search About", "tab")!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("is case insensitive", () => {
    const m = fuzzyMatch("Search", "SRC");
    expect(m).not.toBeNull();
  });
});
