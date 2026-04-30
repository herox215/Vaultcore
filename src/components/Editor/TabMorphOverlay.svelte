<script lang="ts">
  // #380 — char-morph transition between text-file tabs.
  //
  // Mounted once per EditorPane inside `.vc-editor-content`. The parent
  // captures the outgoing snapshot itself (it has to — by the time this
  // component would call `snapshotView`, Svelte has already flipped
  // `display: none` on the outgoing container, making `coordsAtPos`
  // return null for every position) and hands both pre-built snapshots
  // to `playFromSnapshots`. The overlay drives a 120ms rAF morph on a
  // canvas sized to the incoming scroller rect.
  //
  // The CM6 view underneath is never touched — typing during the morph
  // works because `pointer-events: none` is set on the canvas.

  import { onDestroy } from "svelte";
  import {
    buildFrameSchedule,
    buildSchedule,
    decideMorph,
    markMorphSettled,
    newSuppressionState,
    prefersReducedMotion,
    randomGlyph,
    resolveMorphDuration,
    type ScheduledFrame,
    type ScheduledGlyph,
  } from "../../lib/editor/tabMorph";
  import type { FrameRef, ViewSnapshot } from "../../lib/morphTypes";

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let visible = $state(false);

  const suppression = newSuppressionState();
  let rafId: number | null = null;

  function cancelRaf() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function tearDown() {
    cancelRaf();
    visible = false;
    if (canvasEl) {
      const ctx = canvasEl.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    }
    markMorphSettled(suppression, performance.now());
  }

  /**
   * Trigger the morph from pre-captured snapshots. The parent owns the
   * snapshot lifecycle so the outgoing snapshot can be taken before the
   * outgoing CM6 view is hidden by Svelte's reactive display swap.
   * Returns synchronously after deciding play vs. instant.
   */
  export function playFromSnapshots(
    outgoing: ViewSnapshot | null,
    incoming: ViewSnapshot | null,
  ): void {
    const now = performance.now();
    const decision = decideMorph(suppression, now);
    if (decision === "instant") {
      // Chord-cycle suppression after a settled morph — cancel any
      // (defensive, shouldn't happen) leftover rAF and skip.
      cancelRaf();
      visible = false;
      return;
    }
    // decision === "play". If a morph is already in flight, cancel its
    // rAF cleanly so we can re-arm with the new schedule below; the
    // canvas surface stays mounted (visible=true) so there's no flash
    // between the interrupted frame and the first frame of the new
    // morph.
    cancelRaf();
    if (prefersReducedMotion()) {
      markMorphSettled(suppression, now);
      return;
    }
    const duration = resolveMorphDuration();
    if (duration <= 0) {
      // User opted out via --vc-tab-switch-duration: 0 — instant swap.
      markMorphSettled(suppression, now);
      return;
    }
    if (!outgoing || !incoming) {
      markMorphSettled(suppression, now);
      return;
    }
    const hasOutgoingVisual =
      outgoing.glyphs.length > 0 || (outgoing.frames?.length ?? 0) > 0;
    const hasIncomingVisual =
      incoming.glyphs.length > 0 || (incoming.frames?.length ?? 0) > 0;
    if (!hasOutgoingVisual || !hasIncomingVisual) {
      // Nothing visual on at least one side — settle the suppression
      // timer so a chord cycle still behaves and bail without a morph.
      markMorphSettled(suppression, now);
      return;
    }
    runMorph(outgoing, incoming, now, duration);
  }

  function runMorph(outgoing: ViewSnapshot, incoming: ViewSnapshot, startedAt: number, duration: number) {
    visible = true;

    // Defer canvas sizing until the element binds.
    queueMicrotask(() => {
      if (!canvasEl) return;
      const dpr = window.devicePixelRatio || 1;
      const w = incoming.scrollerRect.width;
      const h = incoming.scrollerRect.height;
      canvasEl.width = Math.max(1, Math.floor(w * dpr));
      canvasEl.height = Math.max(1, Math.floor(h * dpr));
      canvasEl.style.width = `${w}px`;
      canvasEl.style.height = `${h}px`;
      const ctx = canvasEl.getContext("2d");
      if (!ctx) {
        tearDown();
        return;
      }
      ctx.scale(dpr, dpr);
      ctx.font = incoming.font;
      ctx.textBaseline = "top";
      ctx.fillStyle = incoming.color;

      const schedule = buildSchedule(outgoing, incoming, Math.random, duration);
      const frameSchedule = buildFrameSchedule(outgoing, incoming, Math.random, duration);
      cancelRaf();
      rafId = requestAnimationFrame((t) =>
        frame(ctx, schedule, frameSchedule, incoming, startedAt, duration, t),
      );
    });
  }

  function frame(
    ctx: CanvasRenderingContext2D,
    schedule: ScheduledGlyph[],
    frameSchedule: ScheduledFrame[],
    incoming: ViewSnapshot,
    startedAt: number,
    duration: number,
    nowDom: number,
  ) {
    if (!canvasEl) {
      tearDown();
      return;
    }
    // performance.now() and the rAF timestamp share the same time origin in
    // browsers, but Tauri's webview can drift. Use rAF's timestamp directly
    // and assume `startedAt` was also performance.now() — close enough for a
    // 120ms window and avoids a second clock read per frame.
    const elapsed = Math.max(0, nowDom - startedAt);
    ctx.clearRect(0, 0, incoming.scrollerRect.width, incoming.scrollerRect.height);

    if (elapsed >= duration) {
      tearDown();
      return;
    }

    // Frames first so glyphs read on top of the card outlines.
    drawFrames(ctx, frameSchedule, elapsed, incoming.color);

    for (const g of schedule) {
      const locked = elapsed >= g.lockInMs;
      let ch: string;
      let alpha = 1;
      if (locked) {
        if (g.to === "") {
          // surplus outgoing glyph fading out — already past lock-in, draw nothing
          continue;
        }
        ch = g.to;
      } else {
        if (g.from === "" && g.to === "") continue;
        if (g.from === "") {
          // incoming-only glyph fading in
          ch = randomGlyph();
          alpha = elapsed / Math.max(1, g.lockInMs);
        } else {
          ch = randomGlyph();
          if (g.to === "") {
            // outgoing-only glyph fading out before its lock-in tear-down
            alpha = 1 - elapsed / Math.max(1, g.lockInMs);
          }
        }
      }
      ctx.globalAlpha = alpha;
      ctx.fillText(ch, g.x, g.y);
    }
    ctx.globalAlpha = 1;

    rafId = requestAnimationFrame((t) =>
      frame(ctx, schedule, frameSchedule, incoming, startedAt, duration, t),
    );
  }

  function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  function pathShape(
    ctx: CanvasRenderingContext2D,
    f: FrameRef,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    ctx.beginPath();
    if (f.shape === "ellipse") {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    }
    if (f.shape === "diamond") {
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      return;
    }
    if (f.shape === "triangle") {
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      return;
    }
    const r = f.shape === "rounded-rectangle" ? Math.min(8, w / 2, h / 2) : 0;
    if (r > 0 && typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.rect(x, y, w, h);
  }

  /**
   * Cross-fade card frames from outgoing → incoming. Each pair has its
   * own random lock-in within the morph window, so dialogs scramble in
   * the same staggered way the glyphs do — no two cards swap at the
   * same instant.
   */
  function drawFrames(
    ctx: CanvasRenderingContext2D,
    frames: ScheduledFrame[],
    elapsed: number,
    fallbackColor: string,
  ) {
    if (frames.length === 0) return;
    ctx.save();
    ctx.lineWidth = 1;
    for (const sf of frames) {
      const lock = Math.max(1, sf.lockInMs);
      const t = Math.min(1, elapsed / lock);
      const locked = elapsed >= sf.lockInMs;
      const target: FrameRef | null = locked ? sf.to : sf.from ?? sf.to;
      if (!target) continue;
      // Interpolate position when both sides exist so cards translate
      // toward their new home rather than teleport.
      let x = target.x;
      let y = target.y;
      let w = target.width;
      let h = target.height;
      if (sf.from && sf.to && !locked) {
        x = lerp(sf.from.x, sf.to.x, t);
        y = lerp(sf.from.y, sf.to.y, t);
        w = lerp(sf.from.width, sf.to.width, t);
        h = lerp(sf.from.height, sf.to.height, t);
      }
      const fadingIn = !sf.from && sf.to;
      const fadingOut = sf.from && !sf.to;
      const alpha = fadingIn ? t : fadingOut ? 1 - t : 1;
      const drawTarget = fadingOut ? sf.from! : target;
      ctx.globalAlpha = alpha * (drawTarget.strokeAlpha ?? 1);
      pathShape(ctx, drawTarget, x, y, w, h);
      if (drawTarget.fill) {
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * 0.25;
        ctx.fillStyle = drawTarget.fill;
        ctx.fill();
        ctx.globalAlpha = prev;
      }
      ctx.strokeStyle = fallbackColor;
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  onDestroy(() => {
    cancelRaf();
  });
</script>

{#if visible}
  <canvas
    bind:this={canvasEl}
    class="vc-tab-morph-canvas"
    aria-hidden="true"
  ></canvas>
{/if}

<style>
  .vc-tab-morph-canvas {
    position: absolute;
    inset: 0;
    z-index: 5;
    pointer-events: none;
  }
</style>
