import { describe, it, expect } from "vitest";
import {
  countWords,
  countCharacters,
  computeCounts,
  stripLeadingFrontmatter,
} from "../wordCount";

describe("stripLeadingFrontmatter", () => {
  it("returns the original text when no frontmatter is present", () => {
    expect(stripLeadingFrontmatter("# Heading\nBody")).toBe("# Heading\nBody");
  });

  it("strips a leading frontmatter block but keeps the body intact", () => {
    const doc = "---\ntitle: X\ntags: [a, b]\n---\n# Body\nhello";
    expect(stripLeadingFrontmatter(doc)).toBe("# Body\nhello");
  });

  it("does NOT strip `---` sections that are not at the very start", () => {
    const doc = "# Heading\n\n---\nnot: frontmatter\n---\nBody";
    expect(stripLeadingFrontmatter(doc)).toBe(doc);
  });
});

describe("countWords", () => {
  it("returns 0 for an empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns 0 for whitespace-only input", () => {
    expect(countWords("   \n\t  \n")).toBe(0);
  });

  it("counts simple words separated by whitespace", () => {
    expect(countWords("the quick brown fox")).toBe(4);
  });

  it("ignores markdown heading markers", () => {
    expect(countWords("# Hello world")).toBe(2);
    expect(countWords("### Another heading here")).toBe(3);
  });

  it("ignores markdown emphasis markers", () => {
    expect(countWords("**bold** and *italic* and ~strike~")).toBe(5);
  });

  it("ignores list bullets and ordered list markers", () => {
    expect(countWords("- one\n- two\n- three")).toBe(3);
    expect(countWords("1. alpha\n2. beta")).toBe(2);
  });

  it("ignores blockquote markers", () => {
    expect(countWords("> quoted text here")).toBe(3);
  });

  it("ignores inline code contents", () => {
    expect(countWords("use `const foo = 1` here")).toBe(2);
  });

  it("ignores fenced code blocks entirely", () => {
    const doc = "before\n```\nlots of code words here\n```\nafter";
    expect(countWords(doc)).toBe(2);
  });

  it("keeps link/image alt text but strips the URL", () => {
    expect(countWords("see [the docs](https://example.com/page) now")).toBe(4);
    expect(countWords("![alt caption here](img.png)")).toBe(3);
  });

  it("keeps wiki-link target text", () => {
    expect(countWords("see [[Some Note]] for details")).toBe(5);
  });

  it("prefers wiki-link alias over target when present", () => {
    expect(countWords("see [[Some Note|the alias text]] now")).toBe(5);
  });

  it("counts hyphenated words as one word", () => {
    expect(countWords("a well-known fact")).toBe(3);
  });

  it("counts contractions as one word", () => {
    expect(countWords("don't won't can't")).toBe(3);
  });

  it("ignores leading frontmatter entirely", () => {
    const doc = "---\ntitle: Ignored\ntags: [a, b, c]\n---\nactual body here";
    expect(countWords(doc)).toBe(3);
  });

  it("counts Unicode letters outside ASCII", () => {
    expect(countWords("café naïve")).toBe(2);
    expect(countWords("über straße")).toBe(2);
  });
});

describe("countCharacters", () => {
  it("returns 0 for empty input", () => {
    expect(countCharacters("")).toBe(0);
  });

  it("counts ASCII characters including whitespace", () => {
    expect(countCharacters("hello world")).toBe(11);
  });

  it("counts newlines and tabs", () => {
    expect(countCharacters("a\nb\tc")).toBe(5);
  });

  it("counts emoji as single code points (surrogate pairs collapsed)", () => {
    // 🌳 is U+1F333, represented in UTF-16 as 2 code units but is a single code point.
    expect(countCharacters("🌳")).toBe(1);
    expect(countCharacters("ab🌳cd")).toBe(5);
  });

  it("does NOT strip frontmatter — characters reflect raw document length", () => {
    const doc = "---\nx: y\n---\nhi";
    expect(countCharacters(doc)).toBe(doc.length);
  });
});

describe("computeCounts", () => {
  it("returns both word and character counts in one call", () => {
    expect(computeCounts("the quick brown fox")).toEqual({
      words: 4,
      characters: 19,
    });
  });

  it("handles empty input", () => {
    expect(computeCounts("")).toEqual({ words: 0, characters: 0 });
  });
});
