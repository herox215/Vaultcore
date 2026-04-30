import { afterEach, describe, expect, it, vi } from "vitest";

import { swipeGesture, __pickSwipe } from "../swipeGesture";

describe("__pickSwipe", () => {
  // The decision-only helper — pure, no DOM. Authoritative coverage for
  // the gesture-recognition logic. The action-level test below exercises
  // the wiring; if jsdom proves flaky on PointerEvent, this layer remains
  // correct.

  it("accepts a right-direction swipe within the left edge zone", () => {
    expect(
      __pickSwipe(
        { x: 10, y: 100, t: 0 },
        { x: 70, y: 110, t: 200 },
        { direction: "right", edge: "left", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(true);
  });

  it("rejects when start is outside the left edge zone", () => {
    expect(
      __pickSwipe(
        { x: 200, y: 100, t: 0 },
        { x: 260, y: 110, t: 200 },
        { direction: "right", edge: "left", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(false);
  });

  it("accepts a left-direction swipe with no edge constraint (full mode)", () => {
    expect(
      __pickSwipe(
        { x: 200, y: 100, t: 0 },
        { x: 100, y: 110, t: 250 },
        { direction: "left", hostWidth: 600 },
      ),
    ).toBe(true);
  });

  it("rejects an opposite-direction swipe", () => {
    expect(
      __pickSwipe(
        { x: 10, y: 100, t: 0 },
        { x: -50, y: 110, t: 200 },
        { direction: "right", edge: "left", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(false);
  });

  it("rejects a vertical-dominant swipe (vertical drift > 30px)", () => {
    expect(
      __pickSwipe(
        { x: 10, y: 100, t: 0 },
        { x: 70, y: 200, t: 250 },
        { direction: "right", edge: "left", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(false);
  });

  it("rejects a swipe that exceeds the 300ms time budget", () => {
    expect(
      __pickSwipe(
        { x: 10, y: 100, t: 0 },
        { x: 70, y: 110, t: 600 },
        { direction: "right", edge: "left", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(false);
  });

  it("rejects a swipe that is shorter than the 50px primary-axis threshold", () => {
    expect(
      __pickSwipe(
        { x: 10, y: 100, t: 0 },
        { x: 40, y: 110, t: 200 },
        { direction: "right", edge: "left", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(false);
  });

  it("accepts a right edge swipe (mirror of left edge)", () => {
    expect(
      __pickSwipe(
        { x: 590, y: 100, t: 0 },
        { x: 520, y: 110, t: 200 },
        { direction: "left", edge: "right", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(true);
  });

  it("rejects a right-edge start when host width places it outside the zone", () => {
    expect(
      __pickSwipe(
        { x: 100, y: 100, t: 0 },
        { x: 30, y: 110, t: 200 },
        { direction: "left", edge: "right", edgeSize: 24, hostWidth: 600 },
      ),
    ).toBe(false);
  });
});

describe("swipeGesture action", () => {
  // Best-effort end-to-end test through the Svelte action contract. jsdom
  // supports PointerEvent with clientX/Y via MouseEventInit since v22.
  // If a future jsdom regression breaks this, the __pickSwipe tests above
  // remain authoritative.

  let host: HTMLDivElement;

  afterEach(() => {
    host?.remove();
  });

  function makeHost(width = 600) {
    host = document.createElement("div");
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({
        left: 0, right: width, top: 0, bottom: 800,
        width, height: 800, x: 0, y: 0, toJSON: () => ({}),
      }),
    });
    document.body.appendChild(host);
    return host;
  }

  function pointer(type: string, x: number, y: number) {
    return new PointerEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      pointerId: 1,
    });
  }

  it("fires onSwipe when a valid right-edge swipe completes", () => {
    const onSwipe = vi.fn();
    const node = makeHost();
    const action = swipeGesture(node, { direction: "right", edge: "left", edgeSize: 24, onSwipe });
    try {
      node.dispatchEvent(pointer("pointerdown", 10, 100));
      node.dispatchEvent(pointer("pointermove", 70, 110));
      node.dispatchEvent(pointer("pointerup", 70, 110));
      expect(onSwipe).toHaveBeenCalledTimes(1);
    } finally {
      action.destroy?.();
    }
  });

  it("does not fire when the start is outside the edge zone", () => {
    const onSwipe = vi.fn();
    const node = makeHost();
    const action = swipeGesture(node, { direction: "right", edge: "left", edgeSize: 24, onSwipe });
    try {
      node.dispatchEvent(pointer("pointerdown", 200, 100));
      node.dispatchEvent(pointer("pointermove", 260, 110));
      node.dispatchEvent(pointer("pointerup", 260, 110));
      expect(onSwipe).not.toHaveBeenCalled();
    } finally {
      action.destroy?.();
    }
  });

  it("destroy() removes listeners — subsequent pointerdown does nothing", () => {
    const onSwipe = vi.fn();
    const node = makeHost();
    const action = swipeGesture(node, { direction: "right", edge: "left", edgeSize: 24, onSwipe });
    action.destroy?.();
    node.dispatchEvent(pointer("pointerdown", 10, 100));
    node.dispatchEvent(pointer("pointermove", 70, 110));
    node.dispatchEvent(pointer("pointerup", 70, 110));
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
