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

  it("source uses no ASCII slashes (\\ U+005C, / U+002F) in any CSS `content:` declaration", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    // Aristotle PR-A review — scan ALL `content:` declarations in the
    // file (not just inside @keyframes), including the @media
    // (prefers-reduced-motion) fallback. Any ASCII slash here would be
    // a regression of the box-drawing-only palette constraint.
    const declarations = src.match(/content:\s*"([^"]*)"/g) ?? [];
    expect(declarations.length).toBeGreaterThan(0);
    for (const decl of declarations) {
      expect(decl).not.toMatch(/[\\/]/);
    }
  });

  it("accepts no props (regression guard for the removed `size` prop)", () => {
    // If AsciiSpinner takes any required props, render() with no props
    // would throw or warn. Mounting clean is the contract.
    const { container } = render(AsciiSpinner);
    expect(container.querySelector("span.vc-ascii-spinner")).toBeTruthy();
  });
});
