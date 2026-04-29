/**
 * #62 — `parseLinkTarget` is the single chokepoint that splits a raw
 * wiki-link target like `[[Note^id]]` / `[[Note#H]]` into its stem +
 * optional anchor. These tests pin precedence (block-id beats heading
 * when both are present), grammar (block id is `[A-Za-z0-9-]+`), case
 * folding (block ids lowercased; heading slugs preserved at parse time
 * so the consumer can compare against Rust's slugged value).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { parseLinkTarget, resolveAnchor, setResolvedAnchors } from "../wikiLink";

describe("parseLinkTarget", () => {
  it("returns stem only when there is no anchor", () => {
    expect(parseLinkTarget("Note")).toEqual({ stem: "Note", anchor: null });
    expect(parseLinkTarget("folder/Note")).toEqual({
      stem: "folder/Note",
      anchor: null,
    });
  });

  it("strips known extensions", () => {
    expect(parseLinkTarget("Note.md").stem).toBe("Note");
    expect(parseLinkTarget("foo.canvas").stem).toBe("foo");
  });

  it("splits a block-id suffix", () => {
    expect(parseLinkTarget("Note^para1")).toEqual({
      stem: "Note",
      anchor: { kind: "block", value: "para1" },
    });
  });

  it("lowercases the block-id value (Obsidian parity)", () => {
    expect(parseLinkTarget("Note^MixedCase").anchor).toEqual({
      kind: "block",
      value: "mixedcase",
    });
  });

  it("rejects a `^foo bar` block-id (whitespace not in grammar)", () => {
    // `^` followed by non-`[A-Za-z0-9-]` is not a valid block id; treat
    // the whole string as a stem.
    expect(parseLinkTarget("Note^bad token")).toEqual({
      stem: "Note^bad token",
      anchor: null,
    });
  });

  it("splits a heading suffix", () => {
    expect(parseLinkTarget("Note#Section")).toEqual({
      stem: "Note",
      anchor: { kind: "heading", value: "Section" },
    });
  });

  it("preserves heading case at parse time (slug lookup folds it)", () => {
    expect(parseLinkTarget("Note#Mixed Case").anchor).toEqual({
      kind: "heading",
      value: "Mixed Case",
    });
  });

  it("treats block-id as winning when both `#` and `^` are present", () => {
    // Obsidian rejects `[[Note#H^id]]`; we match its precedence by
    // anchoring on the trailing `^id`.
    expect(parseLinkTarget("Note#Heading^id")).toEqual({
      stem: "Note#Heading",
      anchor: { kind: "block", value: "id" },
    });
  });

  it("handles `Note^id|alias` style — alias is stripped earlier so this never sees pipes", () => {
    // `parseLinkTarget` operates on the regex group 1 capture; the alias
    // pipe and what follows is captured separately and never reaches
    // here. Pin behaviour for the `^` + no-pipe case.
    expect(parseLinkTarget("Note^id")).toEqual({
      stem: "Note",
      anchor: { kind: "block", value: "id" },
    });
  });
});

describe("resolveAnchor — heading slug parity (#62)", () => {
  beforeEach(() => {
    setResolvedAnchors(
      new Map([
        [
          "doc.md",
          {
            blocks: [],
            // `id` is the slug Rust stored at index time.
            headings: [
              { id: "multi-word-heading", byteStart: 0, byteEnd: 50, jsStart: 0, jsEnd: 50 },
              { id: "düsseldorf", byteStart: 60, byteEnd: 100, jsStart: 60, jsEnd: 100 },
            ],
          },
        ],
      ]),
    );
  });

  it("resolves a multi-word heading link via the slug", () => {
    // The user types `[[doc#Multi Word Heading]]` — the parsed value is
    // the raw heading text. Without slugify the comparison would compare
    // `"multi word heading"` to `"multi-word-heading"` and fail.
    const entry = resolveAnchor("doc.md", { kind: "heading", value: "Multi Word Heading" });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("multi-word-heading");
  });

  it("preserves non-ASCII letters during slug lookup", () => {
    const entry = resolveAnchor("doc.md", { kind: "heading", value: "DÜSSELDORF" });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("düsseldorf");
  });

  it("returns null when the heading slug is unknown", () => {
    expect(
      resolveAnchor("doc.md", { kind: "heading", value: "Missing Heading" }),
    ).toBeNull();
  });
});
