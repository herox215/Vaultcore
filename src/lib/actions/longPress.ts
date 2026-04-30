// longPress (#387) — Pointer-Events Svelte action that fires after a
// configurable hold without crossing a movement threshold. Used to bridge
// touch long-press onto the existing right-click context menus and onto
// the mobile-only "New note here" entry point.
//
// Design notes:
//  - move/up/cancel listeners attach to `document` with capture: true so
//    CodeMirror's `view.dom.setPointerCapture(pointerId)` can't redirect
//    the events past us mid-hold.
//  - Single-pointer enforcement: any second concurrent pointerdown
//    cancels both — multi-touch never surfaces a menu.
//  - On fire, an `AbortController` arms a one-shot capture-phase
//    contextmenu suppressor. iOS Safari fires the synthetic contextmenu
//    on `document`, not the originating element, so the suppressor must
//    live there. `stopImmediatePropagation()` is the only way to defeat
//    CM6's bubble-phase `view.dom` contextmenu handler from a separate
//    listener, since `defaultPrevented` is not consulted by
//    `EditorView.domEventHandlers`.
//  - Five teardown paths abort the suppressor: the fire itself (one-shot),
//    a 600 ms ceiling (≈6× the worst observed iOS/Android synthesis
//    delay), `window.blur`, the next `pointerdown` anywhere, and
//    `destroy()`. Cannot leak into the next gesture.
//  - `e.preventDefault()` on `pointerdown` is gated to `pointerType ===
//    "touch"` only — pen and mouse pass through so Surface pen-drag and
//    desktop focus-on-mousedown stay intact.

export interface LongPressDetail {
  clientX: number;
  clientY: number;
  pointerType: string;
  target: EventTarget | null;
}

export interface LongPressOpts {
  /** Hold duration in ms before fire. Default 500. */
  duration?: number;
  /** Movement (px, Euclidean) that cancels a pending hold. Default 10. */
  moveTolerance?: number;
  /**
   * When true, only fires if `event.target === node` at pointerdown.
   * Used by the empty-tree-area wiring so a pointerdown on a TreeRow
   * descendant does not also fire the wrapper menu.
   */
  strict?: boolean;
  onLongPress: (d: LongPressDetail) => void;
}

const DEFAULT_DURATION = 500;
const DEFAULT_MOVE_TOLERANCE = 10;
// 600 ms = ≈6× the worst-observed iOS/Android synthetic-contextmenu
// dispatch latency after touchend. Higher would risk the suppressor
// surviving into the next user gesture.
const SUPPRESSOR_CEILING_MS = 600;

export function longPress(
  node: HTMLElement,
  initialOpts: LongPressOpts,
): { update(o: LongPressOpts): void; destroy(): void } {
  let opts = initialOpts;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let activePointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startPointerType = "";
  let startTarget: EventTarget | null = null;
  let suppressorAbort: AbortController | null = null;
  // The 600 ms ceiling fires `disarmSuppressor` if no other teardown signal
  // arrives first. The timer ID lives outside the AbortController so
  // `destroy()` can clear it directly — otherwise a fire-then-unmount
  // sequence leaks one pending timeout per cycle.
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

  function disarmSuppressor(): void {
    if (ceilingTimer !== null) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
    if (suppressorAbort) {
      suppressorAbort.abort();
      suppressorAbort = null;
    }
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    activePointerId = null;
  }

  function fire(): void {
    timer = null;
    const detail: LongPressDetail = {
      clientX: startX,
      clientY: startY,
      pointerType: startPointerType,
      target: startTarget,
    };

    // Arm the contextmenu suppressor BEFORE calling the consumer. The
    // synthetic contextmenu can race the consumer's state updates on slow
    // mobile WebViews; arming first guarantees we win that race.
    suppressorAbort = new AbortController();
    const signal = suppressorAbort.signal;

    document.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        // stopImmediatePropagation in capture-phase aborts dispatch to
        // any subsequent listener including bubble-phase handlers
        // attached to the original target (e.g. CM6's view.dom).
        e.stopImmediatePropagation();
        disarmSuppressor();
      },
      { capture: true, signal },
    );

    ceilingTimer = setTimeout(() => disarmSuppressor(), SUPPRESSOR_CEILING_MS);

    window.addEventListener("blur", () => disarmSuppressor(), { signal, once: true });

    // Capture-phase + once: cleanly disarms before any subsequent legit
    // contextmenu has a chance to be suppressed. Sequencing matters —
    // the suppressor disarms BEFORE this pointerdown is handed back to
    // the action's own node-level listener, which then evaluates fresh.
    document.addEventListener("pointerdown", () => disarmSuppressor(), {
      capture: true,
      once: true,
      signal,
    });

    // Reset pointer tracking AFTER suppressor is armed so the
    // disarm-on-next-pointerdown path can see we just fired.
    activePointerId = null;

    opts.onLongPress(detail);
  }

  function onPointerDown(e: PointerEvent): void {
    if (opts.strict && e.target !== node) return;

    // Single-pointer enforcement: a second concurrent pointer kills
    // any pending hold. Disarm the suppressor first (S2) so its
    // teardown ordering is deterministic.
    if (activePointerId !== null) {
      disarmSuppressor();
      cancelTimer();
      return;
    }

    activePointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startPointerType = e.pointerType;
    startTarget = e.target;

    if (e.pointerType === "touch") {
      // Suppress the iOS callout / Android selection magnifier. Touch
      // only: pen and mouse pass through so Surface drag-start and
      // desktop focus-on-mousedown keep working.
      e.preventDefault();
    }

    const duration = opts.duration ?? DEFAULT_DURATION;
    timer = setTimeout(fire, duration);
  }

  function onPointerMove(e: PointerEvent): void {
    if (timer === null || e.pointerId !== activePointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const tolerance = opts.moveTolerance ?? DEFAULT_MOVE_TOLERANCE;
    if (Math.hypot(dx, dy) > tolerance) {
      cancelTimer();
    }
  }

  function onPointerEnd(e: PointerEvent): void {
    if (timer === null || e.pointerId !== activePointerId) return;
    cancelTimer();
  }

  function onScroll(): void {
    if (timer !== null) cancelTimer();
  }

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("pointermove", onPointerMove, { capture: true });
  document.addEventListener("pointerup", onPointerEnd, { capture: true });
  document.addEventListener("pointercancel", onPointerEnd, { capture: true });

  return {
    update(next: LongPressOpts): void {
      opts = next;
    },
    destroy(): void {
      cancelTimer();
      disarmSuppressor();
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("scroll", onScroll);
      document.removeEventListener("pointermove", onPointerMove, { capture: true } as EventListenerOptions);
      document.removeEventListener("pointerup", onPointerEnd, { capture: true } as EventListenerOptions);
      document.removeEventListener("pointercancel", onPointerEnd, { capture: true } as EventListenerOptions);
    },
  };
}
