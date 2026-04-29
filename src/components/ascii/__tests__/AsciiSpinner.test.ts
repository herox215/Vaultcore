// Issue #358 PR A — primitives layer.
// AsciiSpinner is a decorative single-glyph spinner. Tests codify the
// constraints from the plan §0 hard constraints + Socrates v1 must-fixes:
//   - aria-hidden on the visible art (parent owns the meaningful label)
//   - frame set is box-drawing only (no ASCII slashes)
//   - no JS timers (no setInterval / setTimeout)
//   - no props (Socrates v1 nh-11 — `size` removed)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import AsciiSpinner from "../AsciiSpinner.svelte";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(HERE, "../AsciiSpinner.svelte");

describe("AsciiSpinner (#358)", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(window, "setInterval");
    setTimeoutSpy = vi.spyOn(window, "setTimeout");
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it("renders one <span> with class vc-ascii-spinner", () => {
    const { container } = render(AsciiSpinner);
    const span = container.querySelector("span.vc-ascii-spinner");
    expect(span).toBeTruthy();
    expect(span!.tagName).toBe("SPAN");
  });

  it("the rendered span carries aria-hidden=true", () => {
    const { container } = render(AsciiSpinner);
    const span = container.querySelector("span.vc-ascii-spinner")!;
    expect(span.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not invoke any JS timer on mount", () => {
    render(AsciiSpinner);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("source contains box-drawing diagonals U+2572 (╲) and U+2571 (╱)", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    expect(src).toContain("╲");
    expect(src).toContain("╱");
  });

  it("source does not use ASCII slashes (\\ U+005C, / U+002F) inside keyframe content", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    // Extract the @keyframes block(s) and assert no ASCII slash content
    // values appear there. ASCII `/` is allowed elsewhere (e.g. JSDoc,
    // closing tags) but never as a spinner frame.
    const keyframesMatch = src.match(/@keyframes[^{]+\{[\s\S]*?\n\s*\}/g);
    expect(keyframesMatch).toBeTruthy();
    for (const block of keyframesMatch!) {
      // Look for `content: "..."` payloads inside the keyframes.
      const contents = block.match(/content:\s*"([^"]*)"/g) ?? [];
      for (const c of contents) {
        expect(c).not.toMatch(/[\\/]/);
      }
    }
  });

  it("accepts no props (regression guard for the removed `size` prop)", () => {
    // If AsciiSpinner takes any required props, render() with no props
    // would throw or warn. Mounting clean is the contract.
    const { container } = render(AsciiSpinner);
    expect(container.querySelector("span.vc-ascii-spinner")).toBeTruthy();
  });
});
