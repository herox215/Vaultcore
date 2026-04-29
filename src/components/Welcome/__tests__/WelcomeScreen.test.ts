// Issue #358 PR C — welcome wordmark.
// Replaces the visible <h1>VaultCore</h1> with a visually-hidden h1 (so
// SR users still hear the heading) plus an aria-hidden ASCII wordmark
// in a <pre>. The existing tagline below stays as the visible body
// copy. The wordmark is exactly 3 lines (top edge + spaced-letters row
// + bottom edge); the in-box tagline is intentionally dropped.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";

import WelcomeScreen from "../WelcomeScreen.svelte";

function makeProps() {
  return {
    recent: [],
    onOpenVault: () => {},
    onPickVault: () => {},
  };
}

describe("WelcomeScreen ASCII wordmark (#358)", () => {
  it("keeps an h1 with text 'VaultCore' in the DOM (SR-accessible)", () => {
    const { container } = render(WelcomeScreen, makeProps());
    const h1 = container.querySelector("h1");
    expect(h1).toBeTruthy();
    expect(h1!.textContent?.trim()).toBe("VaultCore");
  });

  it("renders the ASCII wordmark in a <pre class=vc-welcome-wordmark> with aria-hidden", () => {
    const { container } = render(WelcomeScreen, makeProps());
    const pre = container.querySelector("pre.vc-welcome-wordmark");
    expect(pre).toBeTruthy();
    expect(pre!.getAttribute("aria-hidden")).toBe("true");
  });

  it("the wordmark contains the spaced-letter sequence V A U L T C O R E", () => {
    const { container } = render(WelcomeScreen, makeProps());
    const text = container.querySelector("pre.vc-welcome-wordmark")!.textContent ?? "";
    expect(text).toContain("V A U L T C O R E");
  });

  it("the wordmark is exactly 3 lines (top edge, wordmark row, bottom edge)", () => {
    const { container } = render(WelcomeScreen, makeProps());
    const text = container.querySelector("pre.vc-welcome-wordmark")!.textContent ?? "";
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    // The first and last lines are box-drawing edges; assert they
    // include the corner glyphs so a future regression that swaps
    // them for a different shape fails fast.
    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("┐");
    expect(lines[2]).toContain("└");
    expect(lines[2]).toContain("┘");
  });
});
