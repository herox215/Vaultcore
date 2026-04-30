/**
 * viewportStore — exposes the current viewport mode, pointer-coarseness, and
 * on-screen keyboard height so mobile-aware components can branch without
 * sprinkling matchMedia / visualViewport calls.
 *
 * Driven by:
 *   - 3 matchMedia listeners — width queries gate layout collapse,
 *     `(pointer: coarse)` gates hit-target bumps. Independent of width: a
 *     desktop with a touchscreen reports coarse pointer at full width and
 *     must still apply 44px hit targets without collapsing the layout.
 *   - 1 `visualViewport.resize` listener (#395) — exposes keyboard height
 *     as `innerHeight - visualViewport.height`. iOS Safari / WKWebView
 *     shrinks visualViewport but NOT innerHeight when the keyboard appears
 *     → formula yields the keyboard height. Android Tauri default
 *     (`adjustResize`) shrinks BOTH → formula yields 0, which is correct
 *     because the OS already resized the WebView.
 *
 * Implemented via Svelte's `readable(initial, start)` so listener teardown
 * is built in: the `start` callback registers handlers and returns a `stop`
 * function that removes them; svelte/store calls `stop` when the subscriber
 * count drops to zero. This avoids the leak that would occur if the store
 * grabbed listeners at module load and never released them.
 *
 * Exports a singleton `viewportStore` for app code and `createViewportStore`
 * for tests so each test gets its own subscription/listener set.
 */
import { readable, type Readable } from "svelte/store";

export type ViewportMode = "desktop" | "tablet" | "mobile";

export interface ViewportState {
  mode: ViewportMode;
  isCoarsePointer: boolean;
  /**
   * #395 — on-screen keyboard height in CSS px. 0 when no keyboard is
   * visible, when `window.visualViewport` is unavailable, or on platforms
   * where the WebView itself resizes (Android `adjustResize`).
   */
  keyboardHeight: number;
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
  keyboardHeight: 0,
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

    // #395 — visualViewport-tracked keyboard height. Closed-over so the
    // matchMedia handler can re-emit consistently with the latest value
    // (a width-MQL flip during a keyboard session must not zero the
    // keyboard height).
    let kbHeight = 0;

    const read = () => {
      set({
        mode: modeFor(mqlMobile.matches, mqlTablet.matches),
        isCoarsePointer: mqlCoarse.matches,
        keyboardHeight: kbHeight,
      });
    };

    read();
    mqlMobile.addEventListener("change", read);
    mqlTablet.addEventListener("change", read);
    mqlCoarse.addEventListener("change", read);

    // #395 — visualViewport listener (iOS keyboard detection). Threshold
    // is 0px: every changed value emits. Per-pixel iOS keyboard animation
    // can produce 60+ events; the cost is one store write each (cheap).
    // Downstream consumers (EditorPane scroll dispatch) gate by 0→>0
    // transition so they don't fire on jitter.
    //
    // No `scroll` listener — that fires on user pan within the visual
    // viewport, NOT on keyboard appearance, and would rewrite the value
    // continuously during normal scrolling.
    const vv = window.visualViewport;
    let onVvResize: (() => void) | undefined;
    if (vv) {
      onVvResize = () => {
        const next = Math.max(
          0,
          Math.round(window.innerHeight - vv.height),
        );
        if (next === kbHeight) return;
        kbHeight = next;
        read();
      };
      vv.addEventListener("resize", onVvResize);
    }

    return () => {
      mqlMobile.removeEventListener("change", read);
      mqlTablet.removeEventListener("change", read);
      mqlCoarse.removeEventListener("change", read);
      if (vv && onVvResize) {
        vv.removeEventListener("resize", onVvResize);
      }
    };
  });
}

export const viewportStore = createViewportStore();
