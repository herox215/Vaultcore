// Issue #358 PR D — primitives layer.
// AsciiSkeleton is a deterministic, static skeleton. Tests codify
// §1.3 of the plan + Socrates v1 m3 (LCG seed-collision regression):
//   - aria-hidden on the host <pre>
//   - exact line count + line width
//   - same seed → same output (determinism)
//   - seed=0 vs seed=1 produce DIFFERENT output (regression for the
//     `(s | 0) || 1` aliasing bug)

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";

import AsciiSkeleton from "../AsciiSkeleton.svelte";

function textOf(container: HTMLElement): string {
  return container.querySelector("pre.vc-ascii-skel")?.textContent ?? "";
}

describe("AsciiSkeleton (#358)", () => {
  it("the host <pre> carries aria-hidden=true", () => {
    const { container } = render(AsciiSkeleton, {
      props: { lines: 3, width: 20, seed: 1 },
    });
    const pre = container.querySelector("pre.vc-ascii-skel")!;
    expect(pre.getAttribute("aria-hidden")).toBe("true");
  });

  it("emits exactly `lines` lines, each `width` chars long", () => {
    const { container } = render(AsciiSkeleton, {
      props: { lines: 3, width: 20, seed: 42 },
    });
    const lines = textOf(container as HTMLElement).split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toHaveLength(20);
      // Lines must consist only of `░` and ASCII space.
      expect(line).toMatch(/^[░ ]+$/);
    }
  });

  it("the same seed yields the same output across two renders (determinism)", () => {
    const a = render(AsciiSkeleton, { props: { lines: 3, width: 20, seed: 7 } });
    const b = render(AsciiSkeleton, { props: { lines: 3, width: 20, seed: 7 } });
    expect(textOf(a.container as HTMLElement)).toBe(textOf(b.container as HTMLElement));
  });

  it("seeds 0 and 1 produce DIFFERENT outputs (Socrates v1 m3 regression)", () => {
    const a = render(AsciiSkeleton, { props: { lines: 3, width: 20, seed: 0 } });
    const b = render(AsciiSkeleton, { props: { lines: 3, width: 20, seed: 1 } });
    expect(textOf(a.container as HTMLElement)).not.toBe(textOf(b.container as HTMLElement));
  });

  // Aristotle PR-D review — narrow widths used to crash with
  // `RangeError: Invalid count value` because
  // `Math.floor(rng() * (width - 8)) + 4` can be negative for small
  // widths, then `"░".repeat(gapAt)` throws. Mounting at boundary
  // widths must NEVER throw.
  it.each([0, 1, 5])("does not throw RangeError when width=%i", (width) => {
    expect(() => {
      render(AsciiSkeleton, { props: { lines: 2, width, seed: 0 } });
    }).not.toThrow();
  });

  it("renders only ░, space, and newline chars even at narrow widths", () => {
    for (const width of [1, 3, 5]) {
      const { container } = render(AsciiSkeleton, {
        props: { lines: 2, width, seed: 7 },
      });
      const text = textOf(container as HTMLElement);
      expect(text).toMatch(/^[░ \n]*$/);
    }
  });
});
