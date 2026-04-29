<script lang="ts">
  // #358 — Decorative single-glyph spinner. The art is aria-hidden; the
  // surrounding container owns the meaningful aria-label / role. Frame
  // rotation is driven entirely by CSS @keyframes on a ::before pseudo;
  // there is no JS timer (no setInterval, setTimeout, or RAF tick).
  // No props — every current call site uses the default. Re-introduce
  // props only when a future caller justifies one.
</script>

<span class="vc-ascii-spinner" aria-hidden="true">─</span>

<style>
  /* The host span is invisible (visibility hidden) so only ::before
     paints. width:1ch keeps the layout box stable across frames. */
  .vc-ascii-spinner {
    display: inline-block;
    font-family: var(--vc-font-mono);
    color: var(--color-text-muted);
    line-height: 1;
    width: 1ch;
    text-align: center;
    visibility: hidden;
    position: relative;
  }
  .vc-ascii-spinner::before {
    visibility: visible;
    position: absolute;
    inset: 0;
    content: "─";
    animation: vc-ascii-spin-frames 800ms steps(4, end) infinite;
  }
  /* Box-drawing diagonals only — never ASCII slashes. The U+2572 (╲)
     and U+2571 (╱) glyphs are intentional; do not regress. */
  @keyframes vc-ascii-spin-frames {
    0%   { content: "─"; }
    25%  { content: "╲"; }
    50%  { content: "│"; }
    75%  { content: "╱"; }
    100% { content: "─"; }
  }
  @media (prefers-reduced-motion: reduce) {
    .vc-ascii-spinner::before {
      animation: none;
      content: "─";
    }
  }
</style>
