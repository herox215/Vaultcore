/**
 * viewportStore — exposes the current viewport mode and pointer-coarseness so
 * mobile-aware components can branch without sprinkling matchMedia calls.
 *
 * Driven by three matchMedia listeners — width queries gate layout collapse,
 * `(pointer: coarse)` gates hit-target bumps. The two are intentionally
 * independent: a desktop with a touchscreen reports coarse pointer at full
 * width, and that path must still apply 44px hit targets without collapsing
 * the layout.
 *
 * Implemented via Svelte's `readable(initial, start)` so listener teardown
 * is built in: the `start` callback registers MQL change handlers and
 * returns a `stop` function that removes them; svelte/store calls `stop`
 * when the subscriber count drops to zero. This avoids the leak that would
 * occur if the store grabbed listeners at module load and never released
 * them.
 *
 * Exports a singleton `viewportStore` for app code and `createViewportStore`
 * for tests so each test gets its own subscription/listener set.
 */
import { readable, type Readable } from "svelte/store";

export type ViewportMode = "desktop" | "tablet" | "mobile";

export interface ViewportState {
  mode: ViewportMode;
  isCoarsePointer: boolean;
}

const Q_MOBILE = "(max-width: 699px)";
const Q_TABLET = "(max-width: 1023px)";
const Q_COARSE = "(pointer: coarse)";

// Frozen so the shared module-level reference handed to `readable()` (and
// returned via `get()` before the first MQL read) cannot be mutated by a
// caller and contaminate every subsequent factory invocation.
const SSR_DEFAULT: ViewportState = Object.freeze({
  mode: "desktop",
  isCoarsePointer: false,
});

function modeFor(mobile: boolean, tablet: boolean): ViewportMode {
  if (mobile) return "mobile";
  if (tablet) return "tablet";
  return "desktop";
}

export function createViewportStore(): Readable<ViewportState> {
  return readable<ViewportState>(SSR_DEFAULT, (set) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    // Some sandboxed WebView configs expose `matchMedia` as a function but
    // throw on invocation. Fall through to the SSR default instead of
    // crashing — the typeof check above only filters the missing case.
    let mqlMobile: MediaQueryList;
    let mqlTablet: MediaQueryList;
    let mqlCoarse: MediaQueryList;
    try {
      mqlMobile = window.matchMedia(Q_MOBILE);
      mqlTablet = window.matchMedia(Q_TABLET);
      mqlCoarse = window.matchMedia(Q_COARSE);
    } catch {
      return;
    }

    const read = () => {
      set({
        mode: modeFor(mqlMobile.matches, mqlTablet.matches),
        isCoarsePointer: mqlCoarse.matches,
      });
    };

    read();
    mqlMobile.addEventListener("change", read);
    mqlTablet.addEventListener("change", read);
    mqlCoarse.addEventListener("change", read);

    return () => {
      mqlMobile.removeEventListener("change", read);
      mqlTablet.removeEventListener("change", read);
      mqlCoarse.removeEventListener("change", read);
    };
  });
}

export const viewportStore = createViewportStore();
