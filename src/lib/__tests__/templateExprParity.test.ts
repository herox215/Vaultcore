// Cross-language parity test for the `{{ ... }}` template-expression regex.
//
// Reads the shared fixture at `test-fixtures/template_expr_parity.json` and
// asserts that `TEMPLATE_EXPR_RE` (JS) produces the same ordered list of
// matched substrings as the fixture declares. The Rust counterpart in
// `src-tauri/src/indexer/link_graph.rs` reads the same fixture and makes the
// same assertion, so any future edit that shifts the regex on ONE side will
// fail CI on the BOTH sides — the safeguard against silent divergence the
// review on #331 asked for.

import { describe, it, expect } from "vitest";
import fixture from "../../../test-fixtures/template_expr_parity.json";
import { TEMPLATE_EXPR_RE } from "../templateExprRegex";

interface ParityCase {
  name: string;
  input: string;
  matches: string[];
}

interface ParityFixture {
  cases: ParityCase[];
}

function allMatches(text: string): string[] {
  const out: string[] = [];
  TEMPLATE_EXPR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_EXPR_RE.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

describe("TEMPLATE_EXPR_RE parity with Rust", () => {
  const { cases } = fixture as ParityFixture;
  for (const c of cases) {
    it(`case: ${c.name}`, () => {
      expect(allMatches(c.input)).toEqual(c.matches);
    });
  }
});
