import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guard for #181: every `svelte-ignore a11y_no_noninteractive_tabindex`
 * in CanvasRenderer.svelte must be immediately followed — within the next
 * ~20 lines — by a `<div>` whose `role` AND `tabindex` both bind to the
 * same `interactive` flag. If someone drops `role={interactive ? ...}`
 * but keeps the ignore, the suppression becomes a real a11y regression;
 * this test fails before it merges.
 */

const SRC = resolve(__dirname, "../src/components/Canvas/CanvasRenderer.svelte");
const WINDOW = 25;
const DIRECTIVE = "svelte-ignore a11y_no_noninteractive_tabindex";

describe("CanvasRenderer a11y ignore directives", () => {
  const text = readFileSync(SRC, "utf8");
  const lines = text.split("\n");

  it("every a11y_no_noninteractive_tabindex ignore is co-located with conditional role + tabindex", () => {
    const occurrences: number[] = [];
    lines.forEach((line, idx) => {
      if (line.includes(DIRECTIVE)) occurrences.push(idx);
    });

    expect(occurrences.length).toBeGreaterThan(0);

    for (const idx of occurrences) {
      const window = lines.slice(idx, idx + WINDOW).join("\n");
      expect(
        window,
        `ignore at line ${idx + 1} has no "role={interactive ?" within ${WINDOW} lines`,
      ).toMatch(/role=\{interactive\s*\?/);
      expect(
        window,
        `ignore at line ${idx + 1} has no "tabindex={interactive ?" within ${WINDOW} lines`,
      ).toMatch(/tabindex=\{interactive\s*\?/);
    }
  });
});
