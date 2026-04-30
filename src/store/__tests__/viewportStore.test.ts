import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { createViewportStore } from "../viewportStore";

type MqlListener = (ev: MediaQueryListEvent) => void;

interface FakeMql {
  media: string;
  matches: boolean;
  listeners: Set<MqlListener>;
  addEventListener: (type: "change", l: MqlListener) => void;
  removeEventListener: (type: "change", l: MqlListener) => void;
  // legacy (unused by our store but populated for compat)
  addListener: (l: MqlListener) => void;
  removeListener: (l: MqlListener) => void;
  onchange: null;
  dispatchEvent: () => boolean;
}

interface MqlHarness {
  matchMedia: (q: string) => FakeMql;
  mqls: Map<string, FakeMql>;
  /** Flip `matches` on the MQL for `query` and dispatch `change`. */
  set: (query: string, matches: boolean) => void;
}

function makeMqlHarness(initial: Record<string, boolean>): MqlHarness {
  const mqls = new Map<string, FakeMql>();

  function getOrCreate(query: string): FakeMql {
    const existing = mqls.get(query);
    if (existing) return existing;
    const mql: FakeMql = {
      media: query,
      matches: initial[query] ?? false,
      listeners: new Set(),
      addEventListener: (type, l) => {
        if (type === "change") mql.listeners.add(l);
      },
      removeEventListener: (type, l) => {
        if (type === "change") mql.listeners.delete(l);
      },
      addListener: (l) => mql.listeners.add(l),
      removeListener: (l) => mql.listeners.delete(l),
      onchange: null,
      dispatchEvent: () => false,
    };
    mqls.set(query, mql);
    return mql;
  }

  return {
    matchMedia: getOrCreate,
    mqls,
    set(query, matches) {
      const mql = getOrCreate(query);
      mql.matches = matches;
      const ev = { matches, media: query } as MediaQueryListEvent;
      for (const l of mql.listeners) l(ev);
    },
  };
}

const Q_MOBILE = "(max-width: 699px)";
const Q_TABLET = "(max-width: 1023px)";
const Q_COARSE = "(pointer: coarse)";

describe("viewportStore", () => {
  let harness: MqlHarness;
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  function installHarness(initial: Record<string, boolean>, width: number) {
    harness = makeMqlHarness(initial);
    vi.stubGlobal("matchMedia", harness.matchMedia);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: harness.matchMedia,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
  }

  it("reports desktop mode when neither width query matches", () => {
    installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false }, 1280);
    const store = createViewportStore();
    const state = get(store);
    expect(state.mode).toBe("desktop");
    expect(state.isCoarsePointer).toBe(false);
    expect(state.width).toBe(1280);
  });

  it("reports tablet mode when only the tablet query matches", () => {
    installHarness({ [Q_MOBILE]: false, [Q_TABLET]: true, [Q_COARSE]: false }, 900);
    const store = createViewportStore();
    expect(get(store).mode).toBe("tablet");
  });

  it("reports mobile mode when both width queries match", () => {
    installHarness({ [Q_MOBILE]: true, [Q_TABLET]: true, [Q_COARSE]: true }, 400);
    const store = createViewportStore();
    const state = get(store);
    expect(state.mode).toBe("mobile");
    expect(state.isCoarsePointer).toBe(true);
  });

  it("transitions desktop → tablet → mobile when width queries flip", () => {
    installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false }, 1280);
    const store = createViewportStore();
    expect(get(store).mode).toBe("desktop");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    harness.set(Q_TABLET, true);
    expect(get(store).mode).toBe("tablet");
    expect(get(store).width).toBe(900);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    harness.set(Q_MOBILE, true);
    expect(get(store).mode).toBe("mobile");
    expect(get(store).width).toBe(400);
  });

  it("toggles isCoarsePointer independent of width", () => {
    installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false }, 1280);
    const store = createViewportStore();
    expect(get(store).isCoarsePointer).toBe(false);

    harness.set(Q_COARSE, true);
    expect(get(store).isCoarsePointer).toBe(true);
    expect(get(store).mode).toBe("desktop");
    expect(get(store).width).toBe(1280);
  });

  it("delivers updates to multiple subscribers", () => {
    installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false }, 1280);
    const store = createViewportStore();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = store.subscribe((s) => seenA.push(s.mode));
    const unsubB = store.subscribe((s) => seenB.push(s.mode));

    harness.set(Q_TABLET, true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    harness.set(Q_TABLET, true); // re-fire to trigger width refresh

    expect(seenA[seenA.length - 1]).toBe("tablet");
    expect(seenB[seenB.length - 1]).toBe("tablet");
    unsubA();
    unsubB();
  });

  it("returns a stable default when window is undefined (SSR / non-browser)", () => {
    vi.stubGlobal("window", undefined);
    const store = createViewportStore();
    const state = get(store);
    expect(state.mode).toBe("desktop");
    expect(state.isCoarsePointer).toBe(false);
    expect(typeof state.width).toBe("number");
  });
});
