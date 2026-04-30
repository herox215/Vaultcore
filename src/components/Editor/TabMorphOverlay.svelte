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
    buildSchedule,
    decideMorph,
    markMorphSettled,
    newSuppressionState,
    prefersReducedMotion,
    randomGlyph,
    resolveMorphDuration,
    type ScheduledGlyph,
    type ViewSnapshot,
  } from "../../lib/editor/tabMorph";

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
      cancelRaf();
      visible = false;
      return;
    }
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
    if (!outgoing || !incoming || outgoing.glyphs.length === 0) {
      // Empty outgoing snapshot means the parent failed to capture in
      // time — settle the suppression timer so a chord cycle still
      // behaves and bail without a morph.
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
      cancelRaf();
      rafId = requestAnimationFrame((t) => frame(ctx, schedule, incoming, startedAt, duration, t));
    });
  }

  function frame(
    ctx: CanvasRenderingContext2D,
    schedule: ScheduledGlyph[],
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

    rafId = requestAnimationFrame((t) => frame(ctx, schedule, incoming, startedAt, duration, t));
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
