import { describe, it, expect } from "vitest";
import { parseTableText, parseAlignments } from "../tablePlugin";

describe("tablePlugin — parseAlignments", () => {
  it("detects default alignment", () => {
    expect(parseAlignments("|------|------|")).toEqual(["default", "default"]);
  });

  it("detects left alignment", () => {
    expect(parseAlignments("|:-----|------|")).toEqual(["left", "default"]);
  });

  it("detects right alignment", () => {
    expect(parseAlignments("|------|-----:|")).toEqual(["default", "right"]);
  });

  it("detects center alignment", () => {
    expect(parseAlignments("|:----:|------|")).toEqual(["center", "default"]);
  });

  it("handles mixed alignments", () => {
    expect(parseAlignments("|:---|:---:|---:|")).toEqual(["left", "center", "right"]);
  });
});

describe("tablePlugin — parseTableText", () => {
  it("parses a simple 2x2 table", () => {
    const text = "| Col1 | Col2 |\n|------|------|\n| A    | B    |";
    const result = parseTableText(text);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["Col1", "Col2"]);
    expect(result!.rows).toEqual([["A", "B"]]);
  });

  it("parses multiple rows", () => {
    const text = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const result = parseTableText(text);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[0]).toEqual(["Alice", "30"]);
    expect(result!.rows[1]).toEqual(["Bob", "25"]);
  });

  it("preserves alignment info", () => {
    const text = "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |";
    const result = parseTableText(text);
    expect(result).not.toBeNull();
    expect(result!.alignments).toEqual(["left", "center", "right"]);
  });

  it("handles header-only tables (no data rows)", () => {
    const text = "| Col1 | Col2 |\n|------|------|";
    const result = parseTableText(text);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["Col1", "Col2"]);
    expect(result!.rows).toEqual([]);
  });

  it("returns null for text without delimiter row", () => {
    expect(parseTableText("| Col1 | Col2 |\n| A | B |")).toBeNull();
  });

  it("returns null for single line", () => {
    expect(parseTableText("| Col1 | Col2 |")).toBeNull();
  });

  it("handles empty cells", () => {
    const text = "| A | B |\n|---|---|\n|   |   |";
    const result = parseTableText(text);
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual(["", ""]);
  });
});
