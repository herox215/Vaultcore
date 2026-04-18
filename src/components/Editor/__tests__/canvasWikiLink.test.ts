// #147 — wiki-links and embeds now resolve `.canvas` targets the same way
// they resolve `.md`. These tests lock in the frontend resolution layer:
// `resolveTarget` strips both extensions and honours the shared lowercased
// stem map that `getResolvedLinks` populates.

import { describe, it, expect, beforeEach } from "vitest";
import { setResolvedLinks, resolveTarget } from "../wikiLink";

describe("resolveTarget — .canvas support (#147)", () => {
  beforeEach(() => {
    setResolvedLinks(new Map());
  });

  it("resolves [[mycanvas]] to the matching .canvas path", () => {
    setResolvedLinks(new Map([["mycanvas", "notes/mycanvas.canvas"]]));
    expect(resolveTarget("mycanvas")).toBe("notes/mycanvas.canvas");
  });

  it("resolves [[mycanvas.canvas]] (explicit extension) to the same target", () => {
    setResolvedLinks(new Map([["mycanvas", "notes/mycanvas.canvas"]]));
    expect(resolveTarget("mycanvas.canvas")).toBe("notes/mycanvas.canvas");
  });

  it("still resolves [[myNote.md]] — the .md branch was not regressed", () => {
    setResolvedLinks(new Map([["mynote", "MyNote.md"]]));
    expect(resolveTarget("MyNote.md")).toBe("MyNote.md");
    expect(resolveTarget("MyNote")).toBe("MyNote.md");
  });

  it("returns null for a target that is neither in the stem map nor aliased", () => {
    setResolvedLinks(new Map());
    expect(resolveTarget("ghost")).toBeNull();
    expect(resolveTarget("ghost.canvas")).toBeNull();
  });

  it("is case-insensitive on the stem lookup", () => {
    setResolvedLinks(new Map([["mycanvas", "mycanvas.canvas"]]));
    expect(resolveTarget("MyCanvas")).toBe("mycanvas.canvas");
    expect(resolveTarget("MYCANVAS.canvas")).toBe("mycanvas.canvas");
  });
});
