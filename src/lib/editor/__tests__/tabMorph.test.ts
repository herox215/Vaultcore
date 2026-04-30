// Unit tests for the pure-logic side of issue #380's tab-morph effect.
// The DOM-side renderer is exercised via the EditorPane integration test;
// the rules below have to be right regardless of how the renderer is wired.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MORPH_DURATION_MS,
  MORPH_SUPPRESSION_MS,
  buildFrameSchedule,
  buildSchedule,
  decideMorph,
  markMorphSettled,
  newSuppressionState,
  prefersReducedMotion,
  randomGlyph,
  resolveMorphDuration,
} from "../tabMorph";
import type { FrameRef, ViewSnapshot } from "../../morphTypes";

function snap(text: string): ViewSnapshot {
  return {
    glyphs: text.split("").map((ch, i) => ({ ch, x: i * 8, y: 0 })),
    lineHeight: 20,
    font: "16px/20px sans-serif",
    color: "#000",
    scrollerRect: { x: 0, y: 0, width: 800, height: 600 },
  };
}

describe("decideMorph — suppression window (#380)", () => {
  let state = newSuppressionState();
  beforeEach(() => {
    state = newSuppressionState();
  });

  it("plays the very first switch", () => {
    expect(decideMorph(state, 1000)).toBe("play");
    expect(state.inFlight).toBe(true);
  });

  it("after a settled morph, plays again once outside the 200ms window", () => {
    decideMorph(state, 1000);
    markMorphSettled(state, 1000 + MORPH_DURATION_MS);
    expect(decideMorph(state, 1000 + MORPH_DURATION_MS + MORPH_SUPPRESSION_MS + 1)).toBe("play");
  });

  it("after a settled morph, instant-swaps inside the 200ms window", () => {
    decideMorph(state, 1000);
    markMorphSettled(state, 1000 + MORPH_DURATION_MS);
    expect(decideMorph(state, 1000 + MORPH_DURATION_MS + 50)).toBe("instant");
  });

  it("subsequent switches inside the window stay instant (timer re-anchors)", () => {
    // First switch settles at t=120.
    decideMorph(state, 0);
    markMorphSettled(state, MORPH_DURATION_MS);

    // Five rapid switches within 200ms of each other — all must be instant.
    let t = MORPH_DURATION_MS + 50;
    for (let i = 0; i < 5; i += 1) {
      expect(decideMorph(state, t)).toBe("instant");
      t += 50;
    }

    // Once the user pauses long enough, the next switch plays.
    t += MORPH_SUPPRESSION_MS + 1;
    expect(decideMorph(state, t)).toBe("play");
  });

  it("a switch arriving while a morph is in flight cancels it (instant)", () => {
    decideMorph(state, 0); // play; inFlight=true
    expect(state.inFlight).toBe(true);
    expect(decideMorph(state, 50)).toBe("instant");
    expect(state.inFlight).toBe(false);
  });
});

describe("buildSchedule", () => {
  it("pairs glyphs by index and pads the shorter side with empty strings", () => {
    const a = snap("hello");
    const b = snap("hi");
    const sched = buildSchedule(a, b, () => 0);
    expect(sched).toHaveLength(5);
    expect(sched.slice(0, 2).map((s) => `${s.from}->${s.to}`)).toEqual(["h->h", "e->i"]);
    expect(sched.slice(2).map((s) => `${s.from}->${s.to}`)).toEqual(["l->", "l->", "o->"]);
  });

  it("places the lock-in time within [0, MORPH_DURATION_MS)", () => {
    const a = snap("abc");
    const b = snap("xyz");
    const calls = [0, 0.5, 0.999];
    let i = 0;
    const sched = buildSchedule(a, b, () => calls[i++]!);
    expect(sched[0]!.lockInMs).toBe(0);
    expect(sched[1]!.lockInMs).toBe(Math.floor(0.5 * MORPH_DURATION_MS));
    expect(sched[2]!.lockInMs).toBe(Math.floor(0.999 * MORPH_DURATION_MS));
  });

  it("falls back to outgoing position when incoming has no glyph at that slot", () => {
    const a = snap("hello");
    const b = snap("hi");
    const sched = buildSchedule(a, b, () => 0);
    // Slots 2..4 are surplus on the outgoing side — they must keep the
    // outgoing x/y so the fade-out doesn't teleport across the canvas.
    expect(sched[2]!.x).toBe(2 * 8);
    expect(sched[3]!.x).toBe(3 * 8);
    expect(sched[4]!.x).toBe(4 * 8);
  });
});

describe("buildFrameSchedule", () => {
  function frame(over: Partial<FrameRef> = {}): FrameRef {
    return { x: 0, y: 0, width: 10, height: 10, shape: "rectangle", ...over };
  }
  function snapWithFrames(frames: FrameRef[]): ViewSnapshot {
    return {
      glyphs: [],
      frames,
      lineHeight: 16,
      font: "14px sans-serif",
      color: "#000",
      scrollerRect: { x: 0, y: 0, width: 100, height: 100 },
    };
  }

  it("pairs frames by index and pads the shorter side with null", () => {
    const a = snapWithFrames([frame({ x: 1 }), frame({ x: 2 }), frame({ x: 3 })]);
    const b = snapWithFrames([frame({ x: 10 })]);
    const sched = buildFrameSchedule(a, b, () => 0);
    expect(sched).toHaveLength(3);
    expect(sched[0]!.from?.x).toBe(1);
    expect(sched[0]!.to?.x).toBe(10);
    expect(sched[1]!.to).toBeNull();
    expect(sched[2]!.to).toBeNull();
  });

  it("treats a missing `frames` array as empty", () => {
    const a: ViewSnapshot = {
      glyphs: [],
      lineHeight: 16,
      font: "14px sans-serif",
      color: "#000",
      scrollerRect: { x: 0, y: 0, width: 1, height: 1 },
    };
    const b = snapWithFrames([frame()]);
    const sched = buildFrameSchedule(a, b, () => 0);
    expect(sched).toHaveLength(1);
    expect(sched[0]!.from).toBeNull();
    expect(sched[0]!.to).not.toBeNull();
  });
});

describe("prefersReducedMotion", () => {
  it("returns false when matchMedia is missing", () => {
    const original = window.matchMedia;
    // @ts-expect-error — deliberately remove for the test
    delete window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
    window.matchMedia = original;
  });

  it("returns true when matchMedia reports the reduce preference", () => {
    const stub = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", stub);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: stub });
    expect(prefersReducedMotion()).toBe(true);
    expect(stub).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });
});

describe("resolveMorphDuration", () => {
  // The CSS variable bleeds across tests in jsdom — clean up so each
  // assertion starts from "no var set".
  beforeEach(() => {
    document.documentElement.style.removeProperty("--vc-tab-switch-duration");
  });

  it("falls back to MORPH_DURATION_MS when the CSS variable is missing", () => {
    expect(resolveMorphDuration()).toBe(MORPH_DURATION_MS);
  });

  it("parses a milliseconds value", () => {
    document.documentElement.style.setProperty("--vc-tab-switch-duration", "200ms");
    expect(resolveMorphDuration()).toBe(200);
  });

  it("parses a seconds value", () => {
    document.documentElement.style.setProperty("--vc-tab-switch-duration", "0.5s");
    expect(resolveMorphDuration()).toBe(500);
  });

  it("returns 0 for an explicit user opt-out", () => {
    document.documentElement.style.setProperty("--vc-tab-switch-duration", "0ms");
    expect(resolveMorphDuration()).toBe(0);
  });

  it("falls back on garbage input", () => {
    document.documentElement.style.setProperty("--vc-tab-switch-duration", "fast");
    expect(resolveMorphDuration()).toBe(MORPH_DURATION_MS);
  });
});

describe("randomGlyph", () => {
  it("emits a printable ASCII character (33–125)", () => {
    for (let i = 0; i < 100; i += 1) {
      const code = randomGlyph().charCodeAt(0);
      expect(code).toBeGreaterThanOrEqual(33);
      expect(code).toBeLessThanOrEqual(125);
    }
  });

  it("is deterministic given a seeded random", () => {
    expect(randomGlyph(() => 0)).toBe("!");
    expect(randomGlyph(() => 0.999)).toBe("}");
  });
});
