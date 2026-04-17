// Unit tests for canvas embed helpers (#71, phase 3).

import { describe, it, expect } from "vitest";
import {
  canvasFilePreview,
  isImageFile,
  isMarkdownFile,
  resolveVaultAbs,
} from "../embed";

describe("isImageFile", () => {
  it("matches common image extensions case-insensitively", () => {
    expect(isImageFile("photo.png")).toBe(true);
    expect(isImageFile("Photo.JPG")).toBe(true);
    expect(isImageFile("sub/image.webp")).toBe(true);
    expect(isImageFile("diagram.svg")).toBe(true);
  });

  it("rejects non-image extensions", () => {
    expect(isImageFile("notes.md")).toBe(false);
    expect(isImageFile("archive.tar.gz")).toBe(false);
    expect(isImageFile("noext")).toBe(false);
  });
});

describe("isMarkdownFile", () => {
  it("matches .md and .markdown", () => {
    expect(isMarkdownFile("readme.md")).toBe(true);
    expect(isMarkdownFile("Notes.MARKDOWN")).toBe(true);
    expect(isMarkdownFile("subdir/a.md")).toBe(true);
  });

  it("rejects other extensions", () => {
    expect(isMarkdownFile("photo.png")).toBe(false);
    expect(isMarkdownFile("readme.txt")).toBe(false);
  });
});

describe("resolveVaultAbs", () => {
  it("joins the vault root and a vault-relative file path", () => {
    expect(resolveVaultAbs("/vault", "notes/a.md")).toBe("/vault/notes/a.md");
  });

  it("normalises trailing slashes and leading slashes", () => {
    expect(resolveVaultAbs("/vault/", "/a.md")).toBe("/vault/a.md");
    expect(resolveVaultAbs("/vault///", "//a.md")).toBe("/vault/a.md");
  });

  it("converts backslashes to forward slashes so the result is portable", () => {
    expect(resolveVaultAbs("C:\\vault", "sub\\file.md")).toBe(
      "C:/vault/sub/file.md",
    );
  });
});

describe("canvasFilePreview", () => {
  it("strips YAML frontmatter", () => {
    const body =
      "---\ntitle: test\ntags: [a,b]\n---\nFirst paragraph body.";
    expect(canvasFilePreview(body)).toBe("First paragraph body.");
  });

  it("truncates at the char limit with an ellipsis", () => {
    const body = "x".repeat(1000);
    const out = canvasFilePreview(body, 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves short bodies untouched", () => {
    expect(canvasFilePreview("short")).toBe("short");
  });
});
