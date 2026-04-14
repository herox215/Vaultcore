import { describe, it, expect } from "vitest";
import { extractHeadings } from "../headings";

describe("extractHeadings", () => {
  it("returns an empty list when there are no headings", () => {
    expect(extractHeadings("Just some plain prose.\n\nNo headings here.")).toEqual([]);
  });

  it("extracts ATX headings with correct levels", () => {
    const doc = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(6);
    expect(result.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.map((h) => h.text)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6"]);
  });

  it("extracts ATX heading text correctly (strips leading hashes and spaces)", () => {
    const result = extractHeadings("## My Heading\n");
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe(2);
    expect(result[0]?.text).toBe("My Heading");
  });

  it("strips optional closing hash marks from ATX headings", () => {
    const result = extractHeadings("## Heading ##\n");
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Heading");
  });

  it("records correct `from` offset for the first heading", () => {
    const doc = "# First\n";
    const result = extractHeadings(doc);
    expect(result[0]?.from).toBe(0);
  });

  it("records correct `from` offset for a heading not on line 1", () => {
    const doc = "Intro paragraph\n\n## Second Heading\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(1);
    expect(result[0]?.from).toBe(17); // 'Intro paragraph\n\n'.length = 17
    expect(result[0]?.line).toBe(3);
  });

  it("preserves document order", () => {
    const doc = "## B Section\n\nSome text.\n\n# A Section\n\n### C Section\n";
    const result = extractHeadings(doc);
    expect(result.map((h) => h.text)).toEqual(["B Section", "A Section", "C Section"]);
    expect(result.map((h) => h.level)).toEqual([2, 1, 3]);
  });

  it("extracts setext H1 headings (underlined with ===)", () => {
    const doc = "My Title\n========\n\nParagraph.\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe(1);
    expect(result[0]?.text).toBe("My Title");
    expect(result[0]?.from).toBe(0);
    expect(result[0]?.line).toBe(1);
  });

  it("extracts setext H2 headings (underlined with ---)", () => {
    const doc = "Sub Title\n---------\n\nParagraph.\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe(2);
    expect(result[0]?.text).toBe("Sub Title");
  });

  it("handles mixed ATX and setext headings in document order", () => {
    const doc = "Intro\n=====\n\n## Sub\n\nAnother\n-------\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(3);
    expect(result[0]?.level).toBe(1);
    expect(result[0]?.text).toBe("Intro");
    expect(result[1]?.level).toBe(2);
    expect(result[1]?.text).toBe("Sub");
    expect(result[2]?.level).toBe(2);
    expect(result[2]?.text).toBe("Another");
  });

  it("ignores lines that look like headings inside the heading text itself", () => {
    const doc = "# Real Heading\n\nNot # a heading\n";
    const result = extractHeadings(doc);
    // Only the first line is an ATX heading; inline # does not produce a heading.
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Real Heading");
  });
});

describe("extractHeadings — frontmatter filtering", () => {
  it("excludes frontmatter property keys from heading results", () => {
    const doc = "---\ntitle: Foo\ntags: [a, b]\n---\n\n# Real Heading\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Real Heading");
  });

  it("returns empty array when document has only frontmatter and no body headings", () => {
    const doc = "---\ntitle: Foo\ntags: [a, b]\n---\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(0);
  });

  it("returns all body headings when there is no frontmatter (regression)", () => {
    const doc = "# First\n\n## Second\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe("First");
    expect(result[1]?.text).toBe("Second");
  });

  it("detects a setext-H2 in the body after frontmatter", () => {
    const doc = "---\ntitle: Foo\n---\n\nSection\n-------\n";
    const result = extractHeadings(doc);
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe(2);
    expect(result[0]?.text).toBe("Section");
  });
});
