import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { createViewportStore } from "../viewportStore";

type MqlListener = (ev: MediaQueryListEvent) => void;

interface FakeMql {
  media: string;
  matches: boolean;
  listeners: Set<MqlListener>;
  addCount: number;
  removeCount: number;
  addEventListener: (type: "change", l: MqlListener) => void;
  removeEventListener: (type: "change", l: MqlListener) => void;
  // legacy (unused but populated for compat)
  addListener: (l: MqlListener) => void;
  removeListener: (l: MqlListener) => void;
  onchange: null;
  dispatchEvent: () => boolean;
}

interface MqlHarness {
  matchMedia: (q: string) => FakeMql;
  mqls: Map<string, FakeMql>;
  /** Flip `matches` and dispatch `change` to all attached listeners. */
  set: (query: string, matches: boolean) => void;
  get: (query: string) => FakeMql;
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
      addCount: 0,
      removeCount: 0,
      addEventListener: (type, l) => {
        if (type !== "change") return;
        mql.addCount++;
        mql.listeners.add(l);
      },
      removeEventListener: (type, l) => {
        if (type !== "change") return;
        mql.removeCount++;
        mql.listeners.delete(l);
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
    get: getOrCreate,
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

function installHarness(initial: Record<string, boolean>): MqlHarness {
  const harness = makeMqlHarness(initial);
  // Per-test override of the global baseline that `src/test/setup.ts` installs
  // via `Object.defineProperty(window, "matchMedia", { configurable: true, ... })`.
  // The `configurable: true` descriptor is what lets `vi.stubGlobal` override
  // it here and lets `vi.unstubAllGlobals()` (in afterEach) restore the
  // baseline — so per-test stubbing only needs `vi.stubGlobal`.
  vi.stubGlobal("matchMedia", harness.matchMedia);
  return harness;
}

describe("viewportStore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports desktop mode when neither width query matches", () => {
    installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false });
    const store = createViewportStore();
    const unsub = store.subscribe(() => {});
    const state = get(store);
    expect(state.mode).toBe("desktop");
    expect(state.isCoarsePointer).toBe(false);
    unsub();
  });

  it("reports tablet mode when only the tablet query matches", () => {
    installHarness({ [Q_MOBILE]: false, [Q_TABLET]: true, [Q_COARSE]: false });
    const store = createViewportStore();
    const unsub = store.subscribe(() => {});
    expect(get(store).mode).toBe("tablet");
    unsub();
  });

  it("reports mobile mode when both width queries match", () => {
    installHarness({ [Q_MOBILE]: true, [Q_TABLET]: true, [Q_COARSE]: true });
    const store = createViewportStore();
    const unsub = store.subscribe(() => {});
    const state = get(store);
    expect(state.mode).toBe("mobile");
    expect(state.isCoarsePointer).toBe(true);
    unsub();
  });

  it("transitions desktop → tablet → mobile when MQLs flip", () => {
    const harness = installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false });
    const store = createViewportStore();
    const seen: string[] = [];
    const unsub = store.subscribe((s) => seen.push(s.mode));

    expect(seen[seen.length - 1]).toBe("desktop");
    harness.set(Q_TABLET, true);
    expect(seen[seen.length - 1]).toBe("tablet");
    harness.set(Q_MOBILE, true);
    expect(seen[seen.length - 1]).toBe("mobile");
    unsub();
  });

  it("toggles isCoarsePointer independent of width", () => {
    const harness = installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false });
    const store = createViewportStore();
    const unsub = store.subscribe(() => {});
    expect(get(store).isCoarsePointer).toBe(false);

    harness.set(Q_COARSE, true);
    expect(get(store).isCoarsePointer).toBe(true);
    expect(get(store).mode).toBe("desktop");
    unsub();
  });

  it("delivers updates to multiple subscribers", () => {
    const harness = installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false });
    const store = createViewportStore();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = store.subscribe((s) => seenA.push(s.mode));
    const unsubB = store.subscribe((s) => seenB.push(s.mode));

    harness.set(Q_TABLET, true);
    expect(seenA[seenA.length - 1]).toBe("tablet");
    expect(seenB[seenB.length - 1]).toBe("tablet");
    unsubA();
    unsubB();
  });

  it("removes every MQL listener it added once the last subscriber unsubscribes", () => {
    const harness = installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false });
    const store = createViewportStore();
    const unsubA = store.subscribe(() => {});
    const unsubB = store.subscribe(() => {});

    // After start, exactly one listener per MQL is registered (first subscriber
    // triggers `start`, second one piggybacks on the same internal store).
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).addCount).toBe(1);
      expect(harness.get(q).removeCount).toBe(0);
    }

    unsubA();
    // Still one subscriber → no teardown yet.
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).removeCount).toBe(0);
    }

    unsubB();
    // Last subscriber gone → svelte/store calls the `stop` returned by `start`.
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).addCount).toBe(harness.get(q).removeCount);
      expect(harness.get(q).listeners.size).toBe(0);
    }
  });

  it("re-runs start() correctly after a multi-subscriber teardown (A+B unsubscribe → C subscribes)", () => {
    // Exercises the path where svelte/store's internal subscriber counter
    // must reach zero before `start` is invoked again. With only a single
    // subscriber per cycle the counter trivially toggles 0→1→0; the
    // multi-subscriber case is where counter arithmetic could regress.
    const harness = installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false });
    const store = createViewportStore();

    const unsubA = store.subscribe(() => {});
    const unsubB = store.subscribe(() => {});
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      // Both subscribers share one start() invocation, so addCount is 1.
      expect(harness.get(q).addCount).toBe(1);
    }
    unsubA();
    unsubB();
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).removeCount).toBe(1);
      expect(harness.get(q).listeners.size).toBe(0);
    }

    // Mutate MQL state while detached so we can also confirm the new
    // start() reads fresh state (not a stale closure carried over).
    harness.get(Q_MOBILE).matches = true;
    harness.get(Q_TABLET).matches = true;
    harness.get(Q_COARSE).matches = true;

    const unsubC = store.subscribe(() => {});
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).addCount).toBe(2);
      expect(harness.get(q).listeners.size).toBe(1);
    }
    expect(get(store).mode).toBe("mobile");
    expect(get(store).isCoarsePointer).toBe(true);
    unsubC();
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).removeCount).toBe(2);
      expect(harness.get(q).listeners.size).toBe(0);
    }
  });

  it("re-attaches listeners and reflects the CURRENT MQL state after a teardown/resubscribe cycle", () => {
    const harness = installHarness({ [Q_MOBILE]: false, [Q_TABLET]: false, [Q_COARSE]: false });
    const store = createViewportStore();

    const unsubA = store.subscribe(() => {});
    unsubA();
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).addCount).toBe(1);
      expect(harness.get(q).removeCount).toBe(1);
    }

    // While no one is subscribed, MQL state changes underneath (e.g. an
    // OS-level dock to a tablet form factor). When a fresh subscriber
    // arrives the store must read the new MQL state, not a stale closure.
    harness.get(Q_TABLET).matches = true;
    harness.get(Q_COARSE).matches = true;

    const unsubB = store.subscribe(() => {});
    for (const q of [Q_MOBILE, Q_TABLET, Q_COARSE]) {
      expect(harness.get(q).addCount).toBe(2);
    }
    expect(get(store).mode).toBe("tablet");
    expect(get(store).isCoarsePointer).toBe(true);
    unsubB();
  });

  it("returns a stable default when window is undefined (SSR / non-browser)", () => {
    vi.stubGlobal("window", undefined);
    const store = createViewportStore();
    const unsub = store.subscribe(() => {});
    const state = get(store);
    expect(state.mode).toBe("desktop");
    expect(state.isCoarsePointer).toBe(false);
    unsub();
  });

  it("falls through to SSR default when matchMedia is a function but throws on call", () => {
    // Some sandboxed WebView configs (e.g. certain WKWebView setups) expose
    // `matchMedia` as a function but throw on invocation. The guard at
    // `typeof matchMedia !== 'function'` doesn't catch that — needs a
    // try/catch around the calls.
    const throwingMatchMedia = vi.fn(() => {
      throw new Error("matchMedia not supported in this context");
    });
    vi.stubGlobal("matchMedia", throwingMatchMedia);

    const store = createViewportStore();
    const unsub = store.subscribe(() => {});
    const state = get(store);
    expect(state.mode).toBe("desktop");
    expect(state.isCoarsePointer).toBe(false);
    // Store must not have left listeners attached on a partially-set-up MQL.
    // (Throwing matchMedia means we never got an MQL to attach to.) Sanity
    // check: subsequent subscribe/unsubscribe cycles don't crash.
    unsub();
    const unsub2 = store.subscribe(() => {});
    unsub2();
  });
});
