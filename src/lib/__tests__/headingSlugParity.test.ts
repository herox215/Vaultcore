/**
 * Cross-language parity fixture for the heading-slug algorithm (#62).
 *
 * The Rust counterpart in `src-tauri/src/indexer/anchors.rs::tests::
 * slugify_parity_fixture` reads the SAME JSON file and asserts identical
 * output. Drift between the two implementations would silently break
 * every multi-word heading anchor — the parity test is the safety net.
 */

import { describe, it, expect } from "vitest";
import fixture from "../../../test-fixtures/slug_parity.json";
import { slugify } from "../headingSlug";

interface Case {
  name: string;
  input: string;
  expected: string;
}

describe("headingSlug parity (#62)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      expect(slugify(c.input)).toBe(c.expected);
    });
  }
});
