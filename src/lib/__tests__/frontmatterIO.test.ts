import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeBody,
  serializeBlock,
  computeFrontmatterEdit,
} from "../frontmatterIO";

describe("parseFrontmatter", () => {
  it("returns empty properties when the doc has no frontmatter", () => {
    const res = parseFrontmatter("# Just a heading\n");
    expect(res.region).toBeNull();
    expect(res.properties).toEqual([]);
  });

  it("parses flat key/value pairs as scalar properties", () => {
    const doc = "---\ntitle: Hello\nstatus: draft\n---\nBody";
    const res = parseFrontmatter(doc);
    expect(res.region).toEqual({ from: 0, to: 35 });
    expect(res.properties).toEqual([
      { key: "title", values: ["Hello"], listStyle: false },
      { key: "status", values: ["draft"], listStyle: false },
    ]);
  });

  it("parses flow-list values into arrays", () => {
    const res = parseFrontmatter("---\ntags: [a, b, c]\n---\n");
    expect(res.properties).toEqual([
      { key: "tags", values: ["a", "b", "c"], listStyle: true },
    ]);
  });

  it("parses empty flow list as empty array with listStyle", () => {
    const res = parseFrontmatter("---\ntags: []\n---\n");
    expect(res.properties).toEqual([
      { key: "tags", values: [], listStyle: true },
    ]);
  });

  it("splits flow-list entries respecting double-quoted commas", () => {
    const res = parseFrontmatter('---\ntags: [a, "b, c", d]\n---\n');
    expect(res.properties).toEqual([
      { key: "tags", values: ["a", "b, c", "d"], listStyle: true },
    ]);
  });

  it("strips single and double quotes from flow entries", () => {
    const res = parseFrontmatter(`---\ntags: ['x', "y", z]\n---\n`);
    expect(res.properties).toEqual([
      { key: "tags", values: ["x", "y", "z"], listStyle: true },
    ]);
  });

  it("parses a YAML block sequence into an array", () => {
    const doc = "---\ntags:\n  - alpha\n  - beta\n  - gamma\n---\n";
    const res = parseFrontmatter(doc);
    expect(res.properties).toEqual([
      { key: "tags", values: ["alpha", "beta", "gamma"], listStyle: true },
    ]);
  });

  it("stops block-sequence parsing at the next key", () => {
    const doc = "---\ntags:\n  - a\n  - b\nnext: v\n---\n";
    const res = parseFrontmatter(doc);
    expect(res.properties).toEqual([
      { key: "tags", values: ["a", "b"], listStyle: true },
      { key: "next", values: ["v"], listStyle: false },
    ]);
  });

  it("keeps a scalar value that happens to be empty as a single empty-string entry", () => {
    const res = parseFrontmatter("---\ntitle:\n---\n");
    expect(res.properties).toEqual([
      { key: "title", values: [""], listStyle: false },
    ]);
  });

  it("ignores lines that don't look like key: value", () => {
    const res = parseFrontmatter("---\ntitle: X\n# not a key\nfoo: bar\n---\n");
    expect(res.properties).toEqual([
      { key: "title", values: ["X"], listStyle: false },
      { key: "foo", values: ["bar"], listStyle: false },
    ]);
  });

  it("handles empty frontmatter", () => {
    const res = parseFrontmatter("---\n\n---\n");
    expect(res.region).not.toBeNull();
    expect(res.properties).toEqual([]);
  });
});

describe("serializeBody / serializeBlock", () => {
  it("emits scalar form for listStyle=false with one value", () => {
    expect(serializeBody([
      { key: "title", values: ["X"], listStyle: false },
    ])).toBe("title: X");
  });

  it("emits flow list for listStyle=true with multiple values", () => {
    expect(serializeBody([
      { key: "tags", values: ["a", "b"], listStyle: true },
    ])).toBe("tags: [a, b]");
  });

  it("emits empty flow list for listStyle=true with zero values", () => {
    expect(serializeBody([
      { key: "tags", values: [], listStyle: true },
    ])).toBe("tags: []");
  });

  it("emits single-entry flow list for listStyle=true with one value", () => {
    expect(serializeBody([
      { key: "tags", values: ["only"], listStyle: true },
    ])).toBe("tags: [only]");
  });

  it("quotes flow entries containing commas or brackets", () => {
    expect(serializeBody([
      { key: "tags", values: ["a, b", "c"], listStyle: true },
    ])).toBe('tags: ["a, b", c]');
  });

  it("quotes flow entries with leading or trailing whitespace", () => {
    expect(serializeBody([
      { key: "tags", values: [" spaced ", "clean"], listStyle: true },
    ])).toBe('tags: [" spaced ", clean]');
  });

  it("quotes empty-string flow entries", () => {
    expect(serializeBody([
      { key: "tags", values: ["", "x"], listStyle: true },
    ])).toBe('tags: ["", x]');
  });

  it("drops rows with empty keys", () => {
    expect(serializeBody([
      { key: "", values: ["orphan"], listStyle: false },
      { key: "title", values: ["X"], listStyle: false },
    ])).toBe("title: X");
  });

  it("returns empty string for empty list in serializeBlock", () => {
    expect(serializeBlock([])).toBe("");
  });

  it("wraps body in --- fences", () => {
    expect(serializeBlock([{ key: "a", values: ["1"], listStyle: false }]))
      .toBe("---\na: 1\n---\n");
  });
});

describe("parse ↔ serialize round-trip", () => {
  it("preserves scalar values", () => {
    const doc = "---\ntitle: Hello\n---\n";
    const { properties } = parseFrontmatter(doc);
    expect(serializeBlock(properties)).toBe(doc);
  });

  it("preserves flow-list values", () => {
    const doc = "---\ntags: [a, b, c]\n---\n";
    const { properties } = parseFrontmatter(doc);
    expect(serializeBlock(properties)).toBe(doc);
  });

  it("preserves empty flow list", () => {
    const doc = "---\ntags: []\n---\n";
    const { properties } = parseFrontmatter(doc);
    expect(serializeBlock(properties)).toBe(doc);
  });

  it("preserves quoted entries through the round-trip", () => {
    const doc = '---\ntags: ["a, b", c]\n---\n';
    const { properties } = parseFrontmatter(doc);
    expect(serializeBlock(properties)).toBe(doc);
  });

  it("collapses block sequence to flow form (lossy but valid YAML)", () => {
    const doc = "---\ntags:\n  - a\n  - b\n---\n";
    const { properties } = parseFrontmatter(doc);
    expect(serializeBlock(properties)).toBe("---\ntags: [a, b]\n---\n");
  });
});

describe("computeFrontmatterEdit", () => {
  it("inserts new block + separator when adding first property to a doc with body", () => {
    const doc = "# Body\n";
    const edit = computeFrontmatterEdit(doc, [{ key: "title", values: ["X"], listStyle: false }]);
    expect(edit).toEqual({ from: 0, to: 0, insert: "---\ntitle: X\n---\n" });
    const after = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
    expect(after).toBe("---\ntitle: X\n---\n# Body\n");
  });

  it("inserts new block without extra newline into empty doc", () => {
    const edit = computeFrontmatterEdit("", [{ key: "a", values: ["1"], listStyle: false }]);
    expect(edit.insert).toBe("---\na: 1\n---\n");
  });

  it("does nothing when props are empty and doc has no frontmatter", () => {
    const edit = computeFrontmatterEdit("# Body\n", []);
    expect(edit).toEqual({ from: 0, to: 0, insert: "" });
  });

  it("strips the block AND the trailing blank separator when removing all properties", () => {
    const doc = "---\ntitle: X\n---\n\n# Body\n";
    const edit = computeFrontmatterEdit(doc, []);
    const after = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
    expect(after).toBe("# Body\n");
  });

  it("replaces the existing block in place when edits change values", () => {
    const doc = "---\ntitle: Old\n---\n# Body\n";
    const edit = computeFrontmatterEdit(doc, [{ key: "title", values: ["New"], listStyle: false }]);
    const after = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
    expect(after).toBe("---\ntitle: New\n---\n# Body\n");
  });

  it("replaces an existing scalar with a list", () => {
    const doc = "---\ntags: foo\n---\n# Body\n";
    const edit = computeFrontmatterEdit(doc, [{ key: "tags", values: ["a", "b"], listStyle: true }]);
    const after = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
    expect(after).toBe("---\ntags: [a, b]\n---\n# Body\n");
  });
});
