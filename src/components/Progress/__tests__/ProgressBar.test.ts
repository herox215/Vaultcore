// Issue #358 PR A — ProgressBar refactor.
// The bar-chart fill is replaced by an AsciiProgressBar. The wrapping
// progressbar role + aria-valuemin/max/now must remain on a non-aria-hidden
// element. The data-testid="progress-fill" stays in DOM so existing
// integration assertions keep working.

import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";

import ProgressBar from "../ProgressBar.svelte";
import { progressStore } from "../../../store/progressStore";

describe("ProgressBar ASCII refactor (#358)", () => {
  beforeEach(() => {
    progressStore.reset();
  });

  it("does not render when progressStore.active is false", () => {
    const { container } = render(ProgressBar);
    expect(container.querySelector('[data-testid="progress-overlay"]')).toBeNull();
  });

  it("renders the AsciiProgressBar when progressStore.active is true", () => {
    progressStore.start(100);
    progressStore.update(25, 100, "/notes/foo.md");
    const { container } = render(ProgressBar);
    expect(container.querySelector('[data-testid="progress-overlay"]')).toBeTruthy();
    expect(container.querySelector(".vc-ascii-pb")).toBeTruthy();
  });

  it("preserves the data-testid=\"progress-fill\" hook on the ASCII bar root", () => {
    progressStore.start(100);
    progressStore.update(40, 100, "/notes/foo.md");
    const { container } = render(ProgressBar);
    const fill = container.querySelector('[data-testid="progress-fill"]');
    expect(fill).toBeTruthy();
    // The hook should live on the AsciiProgressBar host so old WDIO
    // selectors keep resolving.
    expect(fill!.classList.contains("vc-ascii-pb")).toBe(true);
  });

  it("keeps role=progressbar + aria-valuenow/min/max on a non-aria-hidden element", () => {
    progressStore.start(100);
    progressStore.update(40, 100, "/notes/foo.md");
    const { container } = render(ProgressBar);
    const pb = container.querySelector('[role="progressbar"]')!;
    expect(pb).toBeTruthy();
    // The progressbar element itself must not be hidden from AT.
    expect(pb.getAttribute("aria-hidden")).not.toBe("true");
    expect(pb.getAttribute("aria-valuemin")).toBe("0");
    expect(pb.getAttribute("aria-valuemax")).toBe("100");
    expect(pb.getAttribute("aria-valuenow")).toBe("40");
  });

  it("the filled cell count reflects the current/total ratio", () => {
    progressStore.start(100);
    progressStore.update(50, 100, "/notes/foo.md");
    const { container } = render(ProgressBar);
    const filled = container.querySelector(".vc-ascii-pb-filled")!.textContent ?? "";
    const empty = container.querySelector(".vc-ascii-pb-empty")!.textContent ?? "";
    // The total cell count should equal the filled+empty length and the
    // filled count should be ~half (rounding tolerated).
    const total = filled.length + empty.length;
    expect(total).toBeGreaterThan(0);
    expect(Math.abs(filled.length - total / 2)).toBeLessThanOrEqual(1);
  });
});
