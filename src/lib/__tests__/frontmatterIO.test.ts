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

  it("parses flat key/value pairs", () => {
    const doc = "---\ntitle: Hello\nstatus: draft\n---\nBody";
    const res = parseFrontmatter(doc);
    expect(res.region).toEqual({ from: 0, to: 35 });
    expect(res.properties).toEqual([
      { key: "title", value: "Hello" },
      { key: "status", value: "draft" },
    ]);
  });

  it("keeps array-ish values as raw strings", () => {
    const res = parseFrontmatter("---\ntags: [a, b]\n---\n");
    expect(res.properties).toEqual([{ key: "tags", value: "[a, b]" }]);
  });

  it("ignores lines that don't look like key: value", () => {
    const res = parseFrontmatter("---\ntitle: X\n# not a key\nfoo: bar\n---\n");
    expect(res.properties).toEqual([
      { key: "title", value: "X" },
      { key: "foo", value: "bar" },
    ]);
  });

  it("handles empty frontmatter", () => {
    const res = parseFrontmatter("---\n\n---\n");
    expect(res.region).not.toBeNull();
    expect(res.properties).toEqual([]);
  });
});

describe("serializeBody / serializeBlock", () => {
  it("joins key/value pairs with newlines", () => {
    expect(serializeBody([
      { key: "title", value: "X" },
      { key: "tags", value: "[a, b]" },
    ])).toBe("title: X\ntags: [a, b]");
  });

  it("drops rows with empty keys", () => {
    expect(serializeBody([
      { key: "", value: "orphan" },
      { key: "title", value: "X" },
    ])).toBe("title: X");
  });

  it("returns empty string for empty list in serializeBlock", () => {
    expect(serializeBlock([])).toBe("");
  });

  it("wraps body in --- fences", () => {
    expect(serializeBlock([{ key: "a", value: "1" }])).toBe("---\na: 1\n---\n");
  });
});

describe("computeFrontmatterEdit", () => {
  it("inserts new block + separator when adding first property to a doc with body", () => {
    const doc = "# Body\n";
    const edit = computeFrontmatterEdit(doc, [{ key: "title", value: "X" }]);
    expect(edit).toEqual({ from: 0, to: 0, insert: "---\ntitle: X\n---\n" });
    const after = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
    expect(after).toBe("---\ntitle: X\n---\n# Body\n");
  });

  it("inserts new block without extra newline into empty doc", () => {
    const edit = computeFrontmatterEdit("", [{ key: "a", value: "1" }]);
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
    const edit = computeFrontmatterEdit(doc, [{ key: "title", value: "New" }]);
    const after = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
    expect(after).toBe("---\ntitle: New\n---\n# Body\n");
  });
});
