import { describe, it, expect, expectTypeOf } from "vitest";
import type { ParsedLink } from "../src/types/links";

/**
 * Guard for #182. The Rust struct `ParsedLink` (link_graph.rs) serializes as
 * camelCase via `#[serde(rename_all = "camelCase")]`. This test anchors the
 * TypeScript mirror so the IPC boundary stays typed: drifting either side
 * produces a compile error here.
 */
describe("ParsedLink shape matches Rust serde(camelCase)", () => {
  it("accepts the canonical wire shape", () => {
    const wire: ParsedLink = {
      targetRaw: "Folder/Note",
      alias: null,
      lineNumber: 0,
      context: "[[Folder/Note]]",
    };
    expect(wire.targetRaw).toBe("Folder/Note");
    expect(wire.alias).toBeNull();
  });

  it("accepts alias when the link is `[[target|alias]]`", () => {
    const withAlias: ParsedLink = {
      targetRaw: "Note",
      alias: "display text",
      lineNumber: 3,
      context: "see [[Note|display text]]",
    };
    expect(withAlias.alias).toBe("display text");
  });

  it("is structurally identical at the type level", () => {
    expectTypeOf<ParsedLink>().toEqualTypeOf<{
      targetRaw: string;
      alias: string | null;
      lineNumber: number;
      context: string;
    }>();
  });
});
