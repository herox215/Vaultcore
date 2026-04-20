// Unit tests for the multi-segment template program support (#303).
//
// A "program" is the body of a single `{{ ... }}` block. With #303, the body
// may contain one or more expressions separated by `;`. Each segment is
// evaluated independently and the rendered results are concatenated into
// one inline widget.
//
// The splitter must respect:
//   - string literals ("..." and '...' with `\` escapes) so `;` inside a
//     string does not split
//   - parenthesised groups so `;` inside a call arg does not split
//   - lambda bodies so `n => n.x; n.y` (hypothetical — not used today, but
//     the splitter still needs to skip `;` inside `(...)`)
// Backticks are NOT supported by the tokenizer, so we do NOT special-case
// them here — `` `a;b` `` splits on the inner `;`.
//
// Evaluation concatenates segments in order, swallowing per-segment errors
// the same way `templateLivePreview` swallows whole-expression errors today:
// a broken segment renders as empty, adjacent segments keep working.

import { describe, it, expect } from "vitest";
import {
  splitSegments,
  evaluateProgram,
  segmentContainingCursor,
} from "../templateProgram";

describe("templateProgram — splitSegments", () => {
  it("returns one segment when there is no `;`", () => {
    expect(splitSegments("vault.name")).toEqual(["vault.name"]);
  });

  it("splits on a single `;`", () => {
    expect(splitSegments("a;b")).toEqual(["a", "b"]);
  });

  it("splits on multiple `;`", () => {
    expect(splitSegments("a;b;c")).toEqual(["a", "b", "c"]);
  });

  it("preserves surrounding whitespace inside each segment", () => {
    expect(splitSegments(" a ; b ")).toEqual([" a ", " b "]);
  });

  it("does not split on `;` inside a double-quoted string", () => {
    expect(splitSegments('vault.notes.where(n => n.name == "a;b")'))
      .toEqual(['vault.notes.where(n => n.name == "a;b")']);
  });

  it("does not split on `;` inside a single-quoted string", () => {
    expect(splitSegments("vault.notes.where(n => n.name == 'a;b')"))
      .toEqual(["vault.notes.where(n => n.name == 'a;b')"]);
  });

  it("respects `\\\"` escapes inside double-quoted strings", () => {
    // String contains an escaped quote followed by a literal `;`, then the
    // real closing quote. The `;` must NOT split.
    const src = 'a == "x\\";y" ; b';
    expect(splitSegments(src)).toEqual(['a == "x\\";y" ', ' b']);
  });

  it("does not split on `;` inside parentheses", () => {
    expect(splitSegments("foo(a; b); c")).toEqual(["foo(a; b)", " c"]);
  });

  it("handles nested parentheses", () => {
    expect(splitSegments("f(g(a; b); c); d"))
      .toEqual(["f(g(a; b); c)", " d"]);
  });

  it("treats an unterminated string as consuming the rest of the input", () => {
    // The tokenizer throws on unterminated strings, but the splitter must
    // not split on `;` inside one — otherwise a user typing
    // `{{ "hello; world }}` would briefly split the hanging half.
    expect(splitSegments('"a;b')).toEqual(['"a;b']);
  });

  it("handles trailing backslash inside a string without crashing", () => {
    // A backslash at the end of input shouldn't cause an off-by-one.
    expect(splitSegments('"a\\')).toEqual(['"a\\']);
  });

  it("returns two empty segments for `;` alone", () => {
    expect(splitSegments(";")).toEqual(["", ""]);
  });

  it("preserves a leading empty segment", () => {
    expect(splitSegments(";a")).toEqual(["", "a"]);
  });

  it("preserves a trailing empty segment", () => {
    expect(splitSegments("a;")).toEqual(["a", ""]);
  });

  it("does NOT special-case backticks (tokenizer has no template literals)", () => {
    // Backticks aren't real string delimiters in the expression language;
    // the splitter treats them as plain punctuation, so a `;` between them
    // still splits. This keeps the splitter aligned with the tokenizer.
    expect(splitSegments("`a;b`")).toEqual(["`a", "b`"]);
  });
});

describe("templateProgram — evaluateProgram", () => {
  const scope = {
    vault: { name: "MyVault" },
    n: 3,
    s: "hello",
  };

  it("evaluates a single-segment program as one value", () => {
    expect(evaluateProgram("vault.name", scope)).toBe("MyVault");
  });

  it("concatenates segments in declaration order", () => {
    expect(evaluateProgram("vault.name; n", scope)).toBe("MyVault3");
  });

  it("preserves literal separators via string segments", () => {
    // Users can insert literal text by adding a string-literal segment
    // between expression segments.
    expect(evaluateProgram('vault.name; " - "; n', scope)).toBe("MyVault - 3");
  });

  it("swallows a failing segment and renders adjacent segments", () => {
    // `vault.missing` throws on the unknown identifier; the surrounding
    // segments must still render.
    expect(evaluateProgram("vault.name; vault.missing; n", scope))
      .toBe("MyVault3");
  });

  it("swallows a parse error in a segment", () => {
    expect(evaluateProgram("vault.name; @@@; n", scope)).toBe("MyVault3");
  });

  it("returns an empty string when all segments fail", () => {
    expect(evaluateProgram("@@@; @@@", scope)).toBe("");
  });

  it("renders `{{ ; }}` as empty (both segments are empty, parse errors swallowed)", () => {
    expect(evaluateProgram(";", scope)).toBe("");
  });

  it("ignores a trailing `;` with nothing after it", () => {
    expect(evaluateProgram("vault.name;", scope)).toBe("MyVault");
  });

  it("supports whitespace around segments", () => {
    expect(evaluateProgram(" vault.name ; n ", scope)).toBe("MyVault3");
  });
});

describe("templateProgram — segmentContainingCursor", () => {
  // The cursor is a column within the body (0-based). The return shape
  // gives the segment's source plus the cursor offset inside that segment.

  it("returns the whole body when there is no `;`", () => {
    expect(segmentContainingCursor("vault.name", 5)).toEqual({
      segment: "vault.name",
      offsetInSegment: 5,
      segmentStart: 0,
    });
  });

  it("returns the left segment when the cursor sits left of `;`", () => {
    //  index: 0 1 2 3 4
    //  text : v a u l t ;   n
    expect(segmentContainingCursor("vault;n", 3)).toEqual({
      segment: "vault",
      offsetInSegment: 3,
      segmentStart: 0,
    });
  });

  it("returns the right segment when the cursor sits past `;`", () => {
    expect(segmentContainingCursor("vault;n", 7)).toEqual({
      segment: "n",
      offsetInSegment: 1,
      segmentStart: 6,
    });
  });

  it("cursor exactly on `;` belongs to the RIGHT segment (offset 0)", () => {
    // Chose right-biased so that typing `;` then member names feels correct:
    // `{{ a; |}}` should offer completions for the new (empty) segment.
    expect(segmentContainingCursor("a;b", 1)).toEqual({
      segment: "b",
      offsetInSegment: 0,
      segmentStart: 2,
    });
  });

  it("handles `;` inside a string (no split)", () => {
    // The enclosing string protects the `;`; cursor offset 4 is still
    // inside the single logical segment.
    const src = '"a;b" ';
    expect(segmentContainingCursor(src, 4)).toEqual({
      segment: src,
      offsetInSegment: 4,
      segmentStart: 0,
    });
  });

  it("handles cursor at end of body", () => {
    expect(segmentContainingCursor("a;b", 3)).toEqual({
      segment: "b",
      offsetInSegment: 1,
      segmentStart: 2,
    });
  });

  it("handles empty trailing segment after `;`", () => {
    expect(segmentContainingCursor("a;", 2)).toEqual({
      segment: "",
      offsetInSegment: 0,
      segmentStart: 2,
    });
  });
});
