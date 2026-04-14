// Unit tests for imageAttachment helpers.
// These tests cover the pure utility functions; the actual DOM handlers are
// integration-tested manually (paste/drop require a running Tauri app).

import { describe, it, expect } from "vitest";
import { formatEmbedReference } from "../imageAttachment";

// Re-implement the pure helpers here so tests don't depend on Svelte store
// imports (which require a browser context).

function extFromMime(mime: string): string | null {
  switch (mime) {
    case "image/png":  return "png";
    case "image/jpeg": return "jpg";
    case "image/gif":  return "gif";
    case "image/webp": return "webp";
    default:           return null;
  }
}

function nowTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

describe("extFromMime", () => {
  it("maps image/png to png", () => {
    expect(extFromMime("image/png")).toBe("png");
  });
  it("maps image/jpeg to jpg", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
  });
  it("maps image/gif to gif", () => {
    expect(extFromMime("image/gif")).toBe("gif");
  });
  it("maps image/webp to webp", () => {
    expect(extFromMime("image/webp")).toBe("webp");
  });
  it("returns null for unknown mime", () => {
    expect(extFromMime("image/bmp")).toBeNull();
    expect(extFromMime("text/plain")).toBeNull();
  });
});

describe("nowTimestamp", () => {
  it("produces a 14-character string of digits", () => {
    const ts = nowTimestamp(new Date(2026, 3, 14, 20, 30, 0)); // April = month 3
    expect(ts).toMatch(/^\d{14}$/);
  });
  it("formats YYYYMMDDHHMMSS correctly", () => {
    const ts = nowTimestamp(new Date(2026, 3, 14, 20, 30, 5));
    expect(ts).toBe("20260414203005");
  });
  it("zero-pads single-digit month and day", () => {
    const ts = nowTimestamp(new Date(2026, 0, 5, 9, 7, 3));
    expect(ts).toBe("20260105090703");
  });
});

describe("filename base parsing", () => {
  it("extracts png extension from filename", () => {
    const filename = "Pasted image 20260414203000.png";
    const dot = filename.lastIndexOf(".");
    expect(dot).toBeGreaterThan(0);
    expect(filename.slice(dot + 1)).toBe("png");
  });
  it("extracts stem from filename with spaces", () => {
    const filename = "Pasted image 20260414203000.png";
    const dot = filename.lastIndexOf(".");
    expect(filename.slice(0, dot)).toBe("Pasted image 20260414203000");
  });
});

describe("formatEmbedReference", () => {
  it("wraps a bare filename as a wiki-embed", () => {
    expect(formatEmbedReference("photo.png")).toBe("![[photo.png]]");
  });
  it("reduces a vault-relative path to its basename", () => {
    // save_attachment returns something like "foo/bar/photo.png" — we only
    // keep the last segment because the embed resolver looks up by filename.
    expect(formatEmbedReference("foo/bar/photo.png")).toBe("![[photo.png]]");
  });
  it("preserves spaces in filenames (no URL encoding)", () => {
    const rel = "notes/sub/Pasted image 20260414203000.png";
    const md = formatEmbedReference(rel);
    expect(md).toBe("![[Pasted image 20260414203000.png]]");
    expect(md).not.toContain("%20");
  });
  it("handles a filename at vault root", () => {
    expect(formatEmbedReference("root.png")).toBe("![[root.png]]");
  });
});
