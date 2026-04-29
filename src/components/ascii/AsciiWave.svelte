<script lang="ts">
  // #358 — Travelling block-density wave. The crest pattern `░▒▓█▓▒░`
  // moves left-to-right across `width` columns over an 8-frame cycle.
  // Frames are computed once from `width` and `seed`-free (deterministic
  // by width alone) and injected as CSS custom properties so the
  // @keyframes can reference them via `content: var(--vc-wave-fN)`.
  // No JS timer; the animation is driven entirely by CSS @keyframes
  // + steps(8, end). Decorative — aria-hidden; the surrounding caller
  // owns any meaningful aria-label.

  interface Props {
    width?: number;
  }

  let { width = 36 }: Props = $props();

  const FRAMES = 8;
  const CREST = "░▒▓█▓▒░"; // 7 cells, density rises to a peak then falls

  function buildFrames(w: number): string[] {
    const safeW = Math.max(0, w | 0);
    const out: string[] = [];
    for (let i = 0; i < FRAMES; i++) {
      // Spread crest centres evenly across the width so the wave
      // traverses the full strip across one cycle.
      const center = safeW <= 1
        ? 0
        : Math.round((i * (safeW - 1)) / (FRAMES - 1));
      const start = center - 3;
      const cells: string[] = [];
      for (let c = 0; c < safeW; c++) {
        if (c >= start && c < start + CREST.length) {
          cells.push(CREST[c - start]!);
        } else {
          cells.push("░");
        }
      }
      out.push(cells.join(""));
    }
    return out;
  }

  const frames = $derived(buildFrames(width));

  function buildCentredFrame(w: number): string {
    const safeW = Math.max(0, w | 0);
    const start = Math.floor((safeW - CREST.length) / 2);
    const cells: string[] = [];
    for (let c = 0; c < safeW; c++) {
      if (c >= start && c < start + CREST.length) {
        cells.push(CREST[c - start]!);
      } else {
        cells.push("░");
      }
    }
    return cells.join("");
  }

  // Static fallback for prefers-reduced-motion: crest pinned at the
  // visual centre of the strip (independent of the 8-frame cycle, whose
  // discrete steps don't land exactly mid-strip).
  const restFrame = $derived(buildCentredFrame(width));

  // Build the inline style string carrying each frame as a CSS string
  // value. Wrapping in escaped double quotes lets the keyframe's
  // `content: var(--vc-wave-fN)` resolve to a valid <string> token.
  const inlineStyle = $derived(
    frames
      .map((f, i) => `--vc-wave-f${i}: "${f}";`)
      .join(" ") + ` --vc-wave-rest: "${restFrame}";`,
  );
</script>

<span
  class="vc-ascii-wave"
  aria-hidden="true"
  style={inlineStyle}
></span>

<style>
  /* The host has a FIXED height and centres its ::before child via
     flex. Block-fill glyphs (`▒ ▓ █`) span the full character cell
     vertically while `░` covers much less ink — without a clamped
     container, the host's intrinsic height "breathed" as frames cycled
     and the eye saw the wave jumping. Fixed height + flex-centre +
     overflow:hidden prevents that. The 4px vertical padding + margin
     give the row breathing room from neighbouring DOM. */
  .vc-ascii-wave {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    height: 1.4em;
    padding: 4px 0;
    margin: 4px 0;
    box-sizing: content-box;
    overflow: hidden;
    font-family: var(--vc-font-mono);
    font-size: var(--vc-font-size, 14px);
    color: var(--color-text-muted);
    line-height: 1;
    white-space: pre;
    letter-spacing: 0;
    vertical-align: middle;
  }
  .vc-ascii-wave::before {
    content: var(--vc-wave-rest);
    line-height: 1;
    /* The pseudo is the only visual; centre it vertically inside the
       fixed-height host so density swings don't shift the baseline. */
    display: inline-block;
    vertical-align: middle;
    animation: vc-ascii-wave 800ms steps(8, end) infinite;
  }
  @keyframes vc-ascii-wave {
    0%    { content: var(--vc-wave-f0); }
    12.5% { content: var(--vc-wave-f1); }
    25%   { content: var(--vc-wave-f2); }
    37.5% { content: var(--vc-wave-f3); }
    50%   { content: var(--vc-wave-f4); }
    62.5% { content: var(--vc-wave-f5); }
    75%   { content: var(--vc-wave-f6); }
    87.5% { content: var(--vc-wave-f7); }
    100%  { content: var(--vc-wave-f0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .vc-ascii-wave::before {
      animation: none;
      content: var(--vc-wave-rest);
    }
  }
</style>
