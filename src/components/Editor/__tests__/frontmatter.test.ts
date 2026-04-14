import { describe, it, expect } from "vitest";
import { detectFrontmatter } from "../frontmatterPlugin";

describe("detectFrontmatter", () => {
  it("detects a frontmatter block at the start of the document", () => {
    const doc = "---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n";
    const region = detectFrontmatter(doc);
    expect(region).not.toBeNull();
    expect(region!.from).toBe(0);
    expect(doc.slice(region!.from, region!.to)).toBe("---\ntitle: Hello\ntags: [a, b]\n---\n");
    expect(region!.body).toBe("title: Hello\ntags: [a, b]");
  });

  it("returns null when the document has no frontmatter", () => {
    expect(detectFrontmatter("# Just a note\n\nBody.")).toBeNull();
  });

  it("ignores `---` that is not at the very start of the document", () => {
    const doc = "# Heading\n\n---\nnot: frontmatter\n---\n";
    expect(detectFrontmatter(doc)).toBeNull();
  });

  it("ignores a leading blank line before `---`", () => {
    const doc = "\n---\nkey: value\n---\n";
    expect(detectFrontmatter(doc)).toBeNull();
  });

  it("detects frontmatter with CRLF line endings", () => {
    const doc = "---\r\ntitle: X\r\n---\r\nBody";
    const region = detectFrontmatter(doc);
    expect(region).not.toBeNull();
    expect(region!.body).toBe("title: X");
  });

  it("detects frontmatter even when it is the entire document (no trailing newline)", () => {
    const doc = "---\ntitle: X\n---";
    const region = detectFrontmatter(doc);
    expect(region).not.toBeNull();
    expect(region!.to).toBe(doc.length);
  });

  it("detects an empty frontmatter block", () => {
    const doc = "---\n\n---\nBody";
    const region = detectFrontmatter(doc);
    expect(region).not.toBeNull();
    expect(region!.body).toBe("");
  });

  it("only captures the first frontmatter block, not a later `---` pair", () => {
    const doc = "---\nfoo: 1\n---\ntext\n---\nbar: 2\n---\n";
    const region = detectFrontmatter(doc);
    expect(region).not.toBeNull();
    expect(region!.body).toBe("foo: 1");
  });
});
