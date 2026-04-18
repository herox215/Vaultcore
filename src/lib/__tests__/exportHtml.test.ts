// Unit tests for exportHtml (#132) — covers both helpers: collectThemeCss
// (reads CSS custom properties off <html> and serialises them) and
// defaultExportFilename (stripping path + .md to produce a save-dialog
// default name).

import { describe, it, expect, beforeEach } from "vitest";
import { collectThemeCss, defaultExportFilename } from "../exportHtml";

describe("collectThemeCss", () => {
  beforeEach(() => {
    // Reset inline styles between tests so leaked properties from a prior
    // case don't bleed into the next one.
    if (typeof document !== "undefined") {
      document.documentElement.removeAttribute("style");
    }
  });

  it("returns an empty string when no known theme tokens are set", () => {
    expect(collectThemeCss()).toBe("");
  });

  it("emits a `:root { ... }` block with the inline tokens that are set", () => {
    const root = document.documentElement;
    root.style.setProperty("--color-bg", "#101010");
    root.style.setProperty("--color-text", "#f5f5f5");

    const css = collectThemeCss();
    expect(css.startsWith(":root {")).toBe(true);
    expect(css.trimEnd().endsWith("}")).toBe(true);
    expect(css).toContain("--color-bg: #101010;");
    expect(css).toContain("--color-text: #f5f5f5;");
  });

  it("skips tokens that are not set rather than emitting empty values", () => {
    document.documentElement.style.setProperty("--color-bg", "#000");

    const css = collectThemeCss();
    expect(css).toContain("--color-bg: #000;");
    // --color-text is NOT set, so it must not appear in the output.
    expect(css).not.toContain("--color-text:");
  });

  it("does not include custom properties that aren't in the allowlist", () => {
    // Only the allowlisted tokens (THEME_VARS) are emitted — even if the
    // root has an unrelated custom property set, it must not leak into the
    // export (issue #61 scope boundary: user snippets stay in the app).
    document.documentElement.style.setProperty("--my-custom-var", "red");
    document.documentElement.style.setProperty("--color-bg", "#222");

    const css = collectThemeCss();
    expect(css).toContain("--color-bg: #222;");
    expect(css).not.toContain("--my-custom-var");
  });

  it("trims whitespace from computed values", () => {
    // getPropertyValue can return a leading space on some property values;
    // the implementation calls .trim() before emitting.
    document.documentElement.style.setProperty("--color-accent", "  #abc  ");

    const css = collectThemeCss();
    expect(css).toContain("--color-accent: #abc;");
  });

  it("returns empty string when document is undefined (SSR-ish environment)", () => {
    // The module guards against document being undefined. We can't truly
    // delete the global in jsdom, but we can call the function after
    // shadowing — verify the guard by monkey-patching the reference
    // temporarily.
    const originalDocument = (globalThis as unknown as { document: Document })
      .document;
    (globalThis as unknown as { document: Document | undefined }).document =
      undefined;
    try {
      expect(collectThemeCss()).toBe("");
    } finally {
      (globalThis as unknown as { document: Document }).document =
        originalDocument;
    }
  });
});

describe("defaultExportFilename", () => {
  it("strips the .md extension and appends the requested ext", () => {
    expect(defaultExportFilename("/vault/notes/Welcome.md", "html")).toBe(
      "Welcome.html",
    );
  });

  it("handles forward-slash paths", () => {
    expect(defaultExportFilename("/a/b/c/note.md", "pdf")).toBe("note.pdf");
  });

  it("handles backslash (Windows-style) paths", () => {
    expect(defaultExportFilename("C:\\vault\\sub\\Notes.md", "html")).toBe(
      "Notes.html",
    );
  });

  it("is case-insensitive for the .md extension", () => {
    expect(defaultExportFilename("/x/Y.MD", "html")).toBe("Y.html");
    expect(defaultExportFilename("/x/Y.Md", "html")).toBe("Y.html");
  });

  it("leaves non-md extensions intact (they're not stripped)", () => {
    // Only `.md` is stripped. A `.markdown` file keeps its extension as
    // part of the stem — deliberately narrow, matches the source.
    expect(defaultExportFilename("/x/readme.markdown", "html")).toBe(
      "readme.markdown.html",
    );
  });

  it("returns '.<ext>' when the path is an empty string (no fallback)", () => {
    // String.prototype.split on "" yields [""]; .pop() returns "" (not
    // undefined), so the `?? "note"` fallback does NOT kick in. Locking
    // this behavior in here so a future change that tightens it (e.g.
    // `.pop() || "note"`) is a visible diff.
    expect(defaultExportFilename("", "html")).toBe(".html");
  });

  it("returns '.<ext>' for a path that is only slashes", () => {
    expect(defaultExportFilename("///", "html")).toBe(".html");
  });

  it("handles a filename without any extension", () => {
    expect(defaultExportFilename("/x/Notes", "html")).toBe("Notes.html");
  });
});
