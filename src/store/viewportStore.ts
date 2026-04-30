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
 * Pattern: classic writable factory (D-06/RC-01 — see `themeStore.ts`).
 *
 * Exports a singleton `viewportStore` for app code and `createViewportStore`
 * for tests so each test gets its own subscription set.
 */
import { writable, type Readable } from "svelte/store";

export type ViewportMode = "desktop" | "tablet" | "mobile";

export interface ViewportState {
  mode: ViewportMode;
  isCoarsePointer: boolean;
  width: number;
}

const Q_MOBILE = "(max-width: 699px)";
const Q_TABLET = "(max-width: 1023px)";
const Q_COARSE = "(pointer: coarse)";

const SSR_DEFAULT: ViewportState = {
  mode: "desktop",
  isCoarsePointer: false,
  width: 1280,
};

function modeFor(mobile: boolean, tablet: boolean): ViewportMode {
  if (mobile) return "mobile";
  if (tablet) return "tablet";
  return "desktop";
}

export function createViewportStore(): Readable<ViewportState> {
  const _store = writable<ViewportState>(SSR_DEFAULT);

  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { subscribe: _store.subscribe };
  }

  const mqlMobile = window.matchMedia(Q_MOBILE);
  const mqlTablet = window.matchMedia(Q_TABLET);
  const mqlCoarse = window.matchMedia(Q_COARSE);

  function read(): ViewportState {
    return {
      mode: modeFor(mqlMobile.matches, mqlTablet.matches),
      isCoarsePointer: mqlCoarse.matches,
      width: window.innerWidth,
    };
  }

  _store.set(read());
  const onChange = () => _store.set(read());
  mqlMobile.addEventListener("change", onChange);
  mqlTablet.addEventListener("change", onChange);
  mqlCoarse.addEventListener("change", onChange);

  return { subscribe: _store.subscribe };
}

export const viewportStore = createViewportStore();
