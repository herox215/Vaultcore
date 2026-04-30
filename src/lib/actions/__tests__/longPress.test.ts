// Action-level tests for the longPress primitive (#387). These exist as the
// RED side of the TDD pair: they describe the behaviour spec'd in plan v3
// before the action is implemented. The action lives at
// `src/lib/actions/longPress.ts` and is wired into TreeRow / Bookmarks /
// EditorPane.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { longPress, type LongPressDetail, type LongPressOpts } from "../longPress";

// jsdom does not implement PointerEvent, but the action only reads
// `clientX/Y`, `pointerId`, `pointerType`, `target` and uses `preventDefault`.
// A MouseEvent + augmentation matches that surface area without pulling
// in a polyfill.
function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; pointerType?: string } = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: init.pointerId ?? 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "touch", configurable: true });
  return ev;
}

interface Harness {
  node: HTMLElement;
  fired: LongPressDetail[];
  handle: { update(o: LongPressOpts): void; destroy(): void };
}

function mount(opts: Partial<LongPressOpts> = {}): Harness {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const fired: LongPressDetail[] = [];
  const handle = longPress(node, {
    duration: 500,
    moveTolerance: 10,
    onLongPress: (d) => fired.push(d),
    ...opts,
  });
  return { node, fired, handle };
}

describe("longPress action (#387)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("fires after duration with synthesized coords + pointerType + target", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown", { clientX: 30, clientY: 40, pointerType: "touch" }));
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ clientX: 30, clientY: 40, pointerType: "touch" });
    expect(fired[0]!.target).toBe(node);
    handle.destroy();
  });

  it("cancels when pointermove exceeds tolerance (>10px)", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    document.dispatchEvent(pointerEvent("pointermove", { clientX: 12, clientY: 0 }));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    handle.destroy();
  });

  it("does not cancel at exactly the tolerance boundary (=10px)", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    document.dispatchEvent(pointerEvent("pointermove", { clientX: 10, clientY: 0 }));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(1);
    handle.destroy();
  });

  it("cancels on pointerup before duration", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown"));
    vi.advanceTimersByTime(200);
    document.dispatchEvent(pointerEvent("pointerup"));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    handle.destroy();
  });

  it("cancels on pointercancel", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown"));
    document.dispatchEvent(pointerEvent("pointercancel"));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    handle.destroy();
  });

  it("preventDefaults pointerdown when pointerType is touch", () => {
    const { node, handle } = mount();
    const ev = pointerEvent("pointerdown", { pointerType: "touch" });
    node.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    handle.destroy();
  });

  it("does NOT preventDefault pointerdown for mouse (preserves desktop focus)", () => {
    const { node, handle } = mount();
    const ev = pointerEvent("pointerdown", { pointerType: "mouse" });
    node.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    handle.destroy();
  });

  it("does NOT preventDefault pointerdown for pen (preserves Surface drag)", () => {
    const { node, handle } = mount();
    const ev = pointerEvent("pointerdown", { pointerType: "pen" });
    node.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    handle.destroy();
  });

  it("suppresses the synthetic contextmenu after fire", () => {
    const { node, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown"));
    vi.advanceTimersByTime(500);
    const ctx = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.dispatchEvent(ctx);
    expect(ctx.defaultPrevented).toBe(true);
    handle.destroy();
  });

  it("stopImmediatePropagation prevents bubble-phase listeners on view.dom from firing", () => {
    const { node, handle } = mount();
    // Simulate CM6's bubble-phase contextmenu listener on a child element.
    const child = document.createElement("div");
    node.appendChild(child);
    const cmListener = vi.fn();
    child.addEventListener("contextmenu", cmListener);

    node.dispatchEvent(pointerEvent("pointerdown"));
    vi.advanceTimersByTime(500);

    const ctx = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    child.dispatchEvent(ctx);

    expect(cmListener).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("after the 600ms ceiling the suppressor disarms — next contextmenu untouched", () => {
    const { node, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown"));
    vi.advanceTimersByTime(500);
    // Wait past the 600ms ceiling without firing contextmenu.
    vi.advanceTimersByTime(700);
    const later = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    handle.destroy();
  });

  it("window.blur after fire disarms the suppressor", () => {
    const { node, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown"));
    vi.advanceTimersByTime(500);
    window.dispatchEvent(new Event("blur"));
    const later = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    handle.destroy();
  });

  it("a subsequent pointerdown disarms the suppressor", () => {
    const { node, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1 }));
    vi.advanceTimersByTime(500);
    // Different pointerdown lands — suppressor must disarm before any
    // subsequent legit right-click runs.
    document.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2 }));
    const later = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    handle.destroy();
  });

  it("multi-touch: a second concurrent pointerdown cancels — no fire", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1 }));
    node.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2 }));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    handle.destroy();
  });

  it("document-level pointermove cancels (defeats CM6 setPointerCapture)", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown", { pointerId: 7, clientX: 0, clientY: 0 }));
    // Simulate CM6 capture: subsequent moves dispatched on document, not node.
    document.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientX: 50, clientY: 0 }));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    handle.destroy();
  });

  it("strict: true ignores pointerdown whose target is not the node itself", () => {
    const { node, fired, handle } = mount({ strict: true });
    const inner = document.createElement("span");
    node.appendChild(inner);
    inner.dispatchEvent(pointerEvent("pointerdown"));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    handle.destroy();
  });

  it("strict: true fires when target is the node itself", () => {
    const { node, fired, handle } = mount({ strict: true });
    // Dispatching directly on the node sets event.target === node.
    node.dispatchEvent(pointerEvent("pointerdown", { clientX: 5, clientY: 5 }));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(1);
    handle.destroy();
  });

  it("scroll on the node during pending hold cancels the timer", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown"));
    node.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    handle.destroy();
  });

  it("update() swaps the callback in place", () => {
    const { node, handle } = mount();
    const next = vi.fn();
    handle.update({ duration: 500, moveTolerance: 10, onLongPress: next });
    node.dispatchEvent(pointerEvent("pointerdown"));
    vi.advanceTimersByTime(500);
    expect(next).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("destroy() removes listeners + clears any pending timer + aborts pending suppressor", () => {
    const { node, fired, handle } = mount();
    node.dispatchEvent(pointerEvent("pointerdown"));
    handle.destroy();
    vi.advanceTimersByTime(500);
    expect(fired).toHaveLength(0);
    // After destroy, document listeners are gone — a stray contextmenu must
    // not be preventDefault'd by a leaked suppressor.
    const ctx = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.dispatchEvent(ctx);
    expect(ctx.defaultPrevented).toBe(false);
  });
});
