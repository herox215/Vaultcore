// Unit tests for the tab-kind classifier (#49). The classifier is the
// authoritative dispatcher for "what viewer should this file open in?",
// so these tests pin down extension casing, dotfiles, and the unknown-ext
// fallback to "text" (caller is then responsible for the UTF-8 probe).
//
// #388 added the pure `tabSupportsReading` predicate to this module.
// `defaultViewModeForViewport` lives in `lib/viewport.ts` (its own test
// file) so this module stays free of the `viewportStore` matchMedia
// listener — every importer of `getExtension`/`getTabKind` would otherwise
// transitively grab those listeners.

import { describe, it, expect } from "vitest";
import {
  getExtension,
  getTabKind,
  IMAGE_EXTS,
  TEXT_EXTS,
  tabSupportsReading,
} from "../tabKind";
import type { Tab } from "../../store/tabStoreCore";

describe("getExtension", () => {
  it("returns the extension lowercased", () => {
    expect(getExtension("foo.PNG")).toBe("png");
    expect(getExtension("note.md")).toBe("md");
    expect(getExtension("/abs/path/to/Image.JPEG")).toBe("jpeg");
  });

  it("returns empty string when there is no extension", () => {
    expect(getExtension("Makefile")).toBe("");
    expect(getExtension("/abs/no-ext")).toBe("");
  });

  it("treats a leading-dot dotfile as having no extension", () => {
    // ".gitignore" → no extension, the whole basename IS the name
    expect(getExtension(".gitignore")).toBe("");
    expect(getExtension("/path/.env")).toBe("");
  });

  it("returns empty string for a basename ending in a dot", () => {
    expect(getExtension("trailing.")).toBe("");
  });

  it("uses the last segment of the path", () => {
    expect(getExtension("/dir.with.dots/file.txt")).toBe("txt");
  });
});

describe("getTabKind", () => {
  it("classifies markdown extensions as markdown", () => {
    expect(getTabKind("notes.md")).toBe("markdown");
    expect(getTabKind("README.MD")).toBe("markdown");
    expect(getTabKind("doc.markdown")).toBe("markdown");
  });

  it("classifies `.canvas` files as canvas (#71)", () => {
    expect(getTabKind("board.canvas")).toBe("canvas");
    expect(getTabKind("/abs/Notes/board.CANVAS")).toBe("canvas");
  });

  it("classifies all known image extensions as image", () => {
    for (const ext of IMAGE_EXTS) {
      expect(getTabKind(`asset.${ext}`)).toBe("image");
      expect(getTabKind(`asset.${ext.toUpperCase()}`)).toBe("image");
    }
  });

  it("classifies all known text/config extensions as text", () => {
    for (const ext of TEXT_EXTS) {
      expect(getTabKind(`config.${ext}`)).toBe("text");
    }
  });

  it("falls back to text for unknown extensions (caller probes UTF-8)", () => {
    expect(getTabKind("script.py")).toBe("text");
    expect(getTabKind("data.unknownext")).toBe("text");
  });

  it("falls back to text for files with no extension at all", () => {
    expect(getTabKind("Makefile")).toBe("text");
    expect(getTabKind("/abs/no-ext")).toBe("text");
  });

  it("ignores trailing case differences for image vs markdown disambiguation", () => {
    expect(getTabKind("foo.SVG")).toBe("image");
    expect(getTabKind("foo.Md")).toBe("markdown");
  });

  it("never returns 'unsupported' for a static path (only the async probe does)", () => {
    // The synchronous classifier never marks anything unsupported on its own —
    // unsupported is reserved for a runtime UTF-8 decode failure inside
    // openFileAsTab().
    expect(getTabKind("archive.zip")).not.toBe("unsupported");
    expect(getTabKind("binary.bin")).not.toBe("unsupported");
  });
});

// ── #388: tabSupportsReading ────────────────────────────────────────────────

function makeTab(over: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    filePath: "/v/note.md",
    isDirty: false,
    scrollPos: 0,
    cursorPos: 0,
    lastSaved: 0,
    lastSavedContent: "",
    ...over,
  };
}

describe("tabSupportsReading (#388)", () => {
  it("returns false for graph tabs", () => {
    expect(tabSupportsReading(makeTab({ type: "graph" }))).toBe(false);
  });

  it("returns false for image viewer", () => {
    expect(tabSupportsReading(makeTab({ viewer: "image" }))).toBe(false);
  });

  it("returns false for unsupported viewer", () => {
    expect(tabSupportsReading(makeTab({ viewer: "unsupported" }))).toBe(false);
  });

  it("returns false for text viewer", () => {
    // A `.json` / `.txt` tab opens read-only via CM6 but has no Reading Mode
    // path — the renderer is markdown-specific.
    expect(tabSupportsReading(makeTab({ viewer: "text" }))).toBe(false);
  });

  it("returns false for canvas viewer", () => {
    // Canvas tabs render their own surface; ReadingView would have nothing
    // to render. Pre-existing bug at EditorPane.svelte:236 missed this case.
    expect(tabSupportsReading(makeTab({ viewer: "canvas" }))).toBe(false);
  });

  it("returns true for explicit markdown viewer", () => {
    expect(tabSupportsReading(makeTab({ viewer: "markdown" }))).toBe(true);
  });

  it("returns true when viewer is undefined (default markdown)", () => {
    expect(tabSupportsReading(makeTab({}))).toBe(true);
  });
});

// `defaultViewModeForViewport` tests live in `viewport.test.ts` next to
// the source module. Keeps `tabKind.ts` and its test file free of the
// `viewportStore` mock plumbing.
