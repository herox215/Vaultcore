// Issue #358 PR A — primitives layer.
// AsciiProgressBar renders `█`-filled cells over `░`-empty cells. Tests
// codify §1.2 of the plan + Socrates v1 must-fixes/should-fixes:
//   - exact filled/empty cell counts at boundary inputs
//   - clamps negative/over-range values
//   - max=0 does not divide by zero
//   - aria-hidden on the host span
//   - no JS timers
//   - no text node injected between filled and empty spans (whitespace
//     fragility under autoformatters)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/svelte";

import AsciiProgressBar from "../AsciiProgressBar.svelte";

function filledOf(container: HTMLElement): string {
  return container.querySelector(".vc-ascii-pb-filled")?.textContent ?? "";
}
function emptyOf(container: HTMLElement): string {
  return container.querySelector(".vc-ascii-pb-empty")?.textContent ?? "";
}

describe("AsciiProgressBar (#358)", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(window, "setInterval");
  });
  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it("value=0/max=100/width=10 renders all empty", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: 0, max: 100, width: 10 },
    });
    expect(filledOf(container)).toBe("");
    expect(emptyOf(container)).toBe("░".repeat(10));
  });

  it("value=50/max=100/width=10 renders 5 filled + 5 empty", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: 50, max: 100, width: 10 },
    });
    expect(filledOf(container)).toBe("█".repeat(5));
    expect(emptyOf(container)).toBe("░".repeat(5));
  });

  it("value=100/max=100/width=10 renders all filled", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: 100, max: 100, width: 10 },
    });
    expect(filledOf(container)).toBe("█".repeat(10));
    expect(emptyOf(container)).toBe("");
  });

  it("clamps negative values to 0", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: -5, max: 100, width: 10 },
    });
    expect(filledOf(container)).toBe("");
    expect(emptyOf(container)).toBe("░".repeat(10));
  });

  it("clamps over-range values to max", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: 200, max: 100, width: 10 },
    });
    expect(filledOf(container)).toBe("█".repeat(10));
    expect(emptyOf(container)).toBe("");
  });

  it("max=0 renders all empty (no division-by-zero NaN)", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: 50, max: 0, width: 10 },
    });
    expect(filledOf(container)).toBe("");
    expect(emptyOf(container)).toBe("░".repeat(10));
  });

  it("host carries aria-hidden=true", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: 25, max: 100, width: 10 },
    });
    const host = container.querySelector(".vc-ascii-pb")!;
    expect(host.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not invoke setInterval on mount", () => {
    render(AsciiProgressBar, { props: { value: 25, max: 100, width: 10 } });
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("filled and empty spans are direct siblings with no intervening text node", () => {
    const { container } = render(AsciiProgressBar, {
      props: { value: 25, max: 100, width: 10 },
    });
    const host = container.querySelector(".vc-ascii-pb")!;
    // Walk the children list — every node between the filled and empty
    // <span>s must be a Comment, never a Text node. A Text node here
    // would render as an extra glyph and break the bar.
    const children = Array.from(host.childNodes);
    const filledIdx = children.findIndex(
      (n) => n.nodeType === 1 && (n as HTMLElement).classList.contains("vc-ascii-pb-filled"),
    );
    const emptyIdx = children.findIndex(
      (n) => n.nodeType === 1 && (n as HTMLElement).classList.contains("vc-ascii-pb-empty"),
    );
    expect(filledIdx).toBeGreaterThanOrEqual(0);
    expect(emptyIdx).toBeGreaterThan(filledIdx);
    for (let i = filledIdx + 1; i < emptyIdx; i++) {
      const between = children[i]!;
      expect(between.nodeType).not.toBe(Node.TEXT_NODE);
    }
  });
});
