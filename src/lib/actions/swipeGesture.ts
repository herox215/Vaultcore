/**
 * swipeGesture — Svelte action for single-pointer swipe recognition.
 *
 * Two callsites in the mobile shell:
 *   - drawer element with `direction: "left"` to dismiss-on-swipe.
 *   - layout root with `direction: "right", edge: "left"` to open the drawer
 *     from a left-edge drag.
 *
 * Recognition rules (matched by the spec — see `__pickSwipe` tests):
 *   - primary axis travel ≥ 50px
 *   - secondary axis drift ≤ 30px
 *   - elapsed time ≤ 300ms
 *   - if `edge` is set, pointerdown must land within `edgeSize` of that edge
 *     of the host (host width comes from getBoundingClientRect()).
 *
 * Pointer Events are used (not Touch) so the same code path covers stylus,
 * touch, and mouse on Tauri's webview.
 *
 * No `setPointerCapture`. The 50px-in-300ms gesture geometry stays well
 * within both consumer host bounds (240px-wide drawer, full-viewport
 * layout root), so capture isn't needed to keep tracking alive. More
 * importantly, capture would steal events from nested swipeGesture
 * instances — the layout-root listener would override the drawer's,
 * breaking swipe-to-close — and would hold pointer capture across the
 * editor for any touch lasting longer than the budget, corrupting
 * CodeMirror's selection drag. Pointer Events bubble correctly without
 * explicit capture.
 *
 * `__pickSwipe` is exported separately as a pure decision function so unit
 * tests don't depend on jsdom's PointerEvent fidelity.
 */
export type SwipeDirection = "left" | "right";
export type SwipeEdge = "left" | "right";

export interface SwipeGestureOptions {
  direction: SwipeDirection;
  edge?: SwipeEdge;
  edgeSize?: number;
  onSwipe: () => void;
}

export interface SwipePoint {
  x: number;
  y: number;
  t: number;
}

export interface PickSwipeOpts {
  direction: SwipeDirection;
  edge?: SwipeEdge;
  edgeSize?: number;
  hostWidth: number;
}

const PRIMARY_THRESHOLD = 50;
const VERTICAL_LIMIT = 30;
const TIME_BUDGET_MS = 300;

export function __pickSwipe(start: SwipePoint, end: SwipePoint, opts: PickSwipeOpts): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dt = end.t - start.t;

  if (dt > TIME_BUDGET_MS) return false;
  if (Math.abs(dy) > VERTICAL_LIMIT) return false;

  if (opts.direction === "right") {
    if (dx < PRIMARY_THRESHOLD) return false;
  } else {
    if (-dx < PRIMARY_THRESHOLD) return false;
  }

  if (opts.edge !== undefined) {
    const edgeSize = opts.edgeSize ?? 24;
    if (opts.edge === "left") {
      if (start.x > edgeSize) return false;
    } else {
      if (start.x < opts.hostWidth - edgeSize) return false;
    }
  }

  return true;
}

export interface SwipeActionReturn {
  destroy(): void;
  update?(opts: SwipeGestureOptions): void;
}

export function swipeGesture(node: HTMLElement, options: SwipeGestureOptions): SwipeActionReturn {
  let opts = options;
  let start: SwipePoint | null = null;
  let activePointerId: number | null = null;

  function onPointerDown(e: PointerEvent) {
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
    activePointerId = e.pointerId;
  }

  function onPointerMove(e: PointerEvent) {
    if (start === null || e.pointerId !== activePointerId) return;
    const end: SwipePoint = { x: e.clientX, y: e.clientY, t: performance.now() };
    const rect = node.getBoundingClientRect();
    if (
      __pickSwipe(start, end, {
        direction: opts.direction,
        ...(opts.edge !== undefined ? { edge: opts.edge } : {}),
        ...(opts.edgeSize !== undefined ? { edgeSize: opts.edgeSize } : {}),
        hostWidth: rect.width,
      })
    ) {
      opts.onSwipe();
      reset();
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (start === null || e.pointerId !== activePointerId) {
      reset();
      return;
    }
    const end: SwipePoint = { x: e.clientX, y: e.clientY, t: performance.now() };
    const rect = node.getBoundingClientRect();
    if (
      __pickSwipe(start, end, {
        direction: opts.direction,
        ...(opts.edge !== undefined ? { edge: opts.edge } : {}),
        ...(opts.edgeSize !== undefined ? { edgeSize: opts.edgeSize } : {}),
        hostWidth: rect.width,
      })
    ) {
      opts.onSwipe();
    }
    reset();
  }

  function onPointerCancel() {
    reset();
  }

  function reset() {
    start = null;
    activePointerId = null;
  }

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", onPointerUp);
  node.addEventListener("pointercancel", onPointerCancel);

  return {
    destroy() {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerCancel);
    },
    update(next: SwipeGestureOptions) {
      opts = next;
    },
  };
}
