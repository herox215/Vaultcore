// Unit tests for the embed-parsing helpers in embedPlugin.ts.
//
// The CM6 ViewPlugin itself requires a live EditorView and Tauri runtime
// (convertFileSrc + readFile), which isn't available in jsdom. We test the
// pure building blocks — regex shapes, size-token parsing, extension detection
// — so regressions in those show up here.

import { describe, it, expect } from "vitest";
import { parseSizePx } from "../embedPlugin";

// Regex copies mirror embedPlugin.ts so the test asserts the actual shapes.
// If embedPlugin.ts changes, update these — they're small on purpose.
const WIKI_EMBED_RE = /!\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]*))?\]\]/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

function isImageFilename(name: string): boolean {
  return IMAGE_EXT_RE.test(name);
}

function matchAll(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

describe("WIKI_EMBED_RE", () => {
  it("matches a bare image embed", () => {
    const m = matchAll(WIKI_EMBED_RE, "prefix ![[foo.png]] suffix");
    expect(m).toHaveLength(1);
    expect(m[0]![1]).toBe("foo.png");
    expect(m[0]![2]).toBeUndefined();
    expect(m[0]![3]).toBeUndefined();
  });

  it("captures a sizing token after the pipe", () => {
    const m = matchAll(WIKI_EMBED_RE, "![[photo.jpg|300]]");
    expect(m).toHaveLength(1);
    expect(m[0]![1]).toBe("photo.jpg");
    expect(m[0]![3]).toBe("300");
  });

  it("captures a heading separately from the target", () => {
    const m = matchAll(WIKI_EMBED_RE, "![[OtherNote#Intro]]");
    expect(m).toHaveLength(1);
    expect(m[0]![1]).toBe("OtherNote");
    expect(m[0]![2]).toBe("Intro");
  });

  it("captures heading + sizing together", () => {
    const m = matchAll(WIKI_EMBED_RE, "![[doc#Section|200]]");
    expect(m[0]![1]).toBe("doc");
    expect(m[0]![2]).toBe("Section");
    expect(m[0]![3]).toBe("200");
  });

  it("matches note embeds without extension", () => {
    const m = matchAll(WIKI_EMBED_RE, "![[MyNote]]");
    expect(m).toHaveLength(1);
    expect(m[0]![1]).toBe("MyNote");
  });

  it("matches multiple embeds in one document", () => {
    const m = matchAll(
      WIKI_EMBED_RE,
      "line1 ![[a.png]] line2 ![[b.jpg|400]] line3 ![[NoteX]]",
    );
    expect(m).toHaveLength(3);
    expect(m.map((x) => x[1])).toEqual(["a.png", "b.jpg", "NoteX"]);
  });

  it("does not confuse a plain wiki-link with an embed", () => {
    // No leading `!` → not an embed. The wiki-link plugin owns this shape.
    const m = matchAll(WIKI_EMBED_RE, "[[JustALink]]");
    expect(m).toHaveLength(0);
  });

  it("does not match a stray `![[` with no closing brackets", () => {
    const m = matchAll(WIKI_EMBED_RE, "![[unterminated");
    expect(m).toHaveLength(0);
  });
});

describe("MD_IMAGE_RE", () => {
  it("captures a simple markdown image path", () => {
    const m = matchAll(MD_IMAGE_RE, "![](attachments/photo.png)");
    expect(m).toHaveLength(1);
    expect(m[0]![1]).toBe("attachments/photo.png");
  });

  it("captures a URL-encoded path", () => {
    const m = matchAll(MD_IMAGE_RE, "![alt](attachments/Pasted%20image%202026.png)");
    expect(m).toHaveLength(1);
    expect(m[0]![1]).toBe("attachments/Pasted%20image%202026.png");
  });

  it("captures the path when alt text is present", () => {
    const m = matchAll(MD_IMAGE_RE, "![a photograph](sub/photo.jpg)");
    expect(m[0]![1]).toBe("sub/photo.jpg");
  });

  it("decodes percent escapes back to spaces", () => {
    const raw = "attachments/Pasted%20image.png";
    expect(decodeURI(raw)).toBe("attachments/Pasted image.png");
  });
});

describe("isImageFilename (extension detection)", () => {
  it("accepts common raster extensions case-insensitively", () => {
    expect(isImageFilename("a.png")).toBe(true);
    expect(isImageFilename("a.PNG")).toBe(true);
    expect(isImageFilename("a.jpg")).toBe(true);
    expect(isImageFilename("a.jpeg")).toBe(true);
    expect(isImageFilename("a.gif")).toBe(true);
    expect(isImageFilename("a.webp")).toBe(true);
    expect(isImageFilename("a.svg")).toBe(true);
  });

  it("rejects non-image extensions and extensionless names", () => {
    expect(isImageFilename("note")).toBe(false);
    expect(isImageFilename("OtherNote")).toBe(false);
    expect(isImageFilename("file.md")).toBe(false);
    expect(isImageFilename("archive.zip")).toBe(false);
  });
});

describe("parseSizePx", () => {
  it("extracts a positive integer from a pure-digit token", () => {
    expect(parseSizePx("300")).toBe(300);
  });

  it("extracts a leading integer and ignores trailing text", () => {
    expect(parseSizePx("200px")).toBe(200);
    expect(parseSizePx("150 tall")).toBe(150);
  });

  it("tolerates leading whitespace", () => {
    expect(parseSizePx("  42")).toBe(42);
  });

  it("returns null for non-numeric aliases", () => {
    expect(parseSizePx("alias text")).toBeNull();
    expect(parseSizePx("foo")).toBeNull();
  });

  it("returns null for missing and empty input", () => {
    expect(parseSizePx(undefined)).toBeNull();
    expect(parseSizePx("")).toBeNull();
  });

  it("returns null for zero", () => {
    expect(parseSizePx("0")).toBeNull();
  });
});
