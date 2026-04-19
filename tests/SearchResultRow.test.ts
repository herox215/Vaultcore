// #204 — SearchResultRow renders a subtle indicator when a hit was
// surfaced only by the semantic (vec) leg of hybrid_search. The ticket
// AC is: "Result-Rows zeigen dezenten Indicator bei Semantic-Match."
//
// We treat "semantic-only" as vecRank != null && bm25Rank == null:
//   - If BM25 also ranked the hit, the lexical surface already explains
//     why it appears → no new information to show.
//   - If only the vec leg surfaced it, the user gains from knowing this
//     came in via semantic similarity rather than keyword match.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import SearchResultRow from "../src/components/Search/SearchResultRow.svelte";
import type { HybridHit } from "../src/types/search";

const INDICATOR_SELECTOR = ".vc-search-result-semantic-indicator";

function makeHit(overrides: Partial<HybridHit>): HybridHit {
  return {
    path: "/vault/Note.md",
    title: "Note",
    score: 0.1,
    snippet: "<b>preview</b> text",
    matchCount: 1,
    ...overrides,
  };
}

describe("SearchResultRow semantic indicator (#204)", () => {
  it("does not render the indicator for BM25-only hits", () => {
    const { container } = render(SearchResultRow, {
      result: makeHit({ bm25Rank: 0, bm25Score: 5.2 }),
      onclick: () => {},
    });
    expect(container.querySelector(INDICATOR_SELECTOR)).toBeNull();
  });

  it("does not render the indicator for hybrid hits that surface in both legs", () => {
    const { container } = render(SearchResultRow, {
      result: makeHit({
        bm25Rank: 0,
        bm25Score: 5.2,
        vecRank: 2,
        vecScore: 0.71,
      }),
      onclick: () => {},
    });
    expect(container.querySelector(INDICATOR_SELECTOR)).toBeNull();
  });

  it("renders the indicator when only the vec leg surfaced the hit", () => {
    const { container } = render(SearchResultRow, {
      result: makeHit({ vecRank: 0, vecScore: 0.83 }),
      onclick: () => {},
    });
    const badge = container.querySelector(INDICATOR_SELECTOR);
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toMatch(/semantisch/i);
  });
});
