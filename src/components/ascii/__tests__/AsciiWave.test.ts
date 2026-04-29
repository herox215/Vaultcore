// Issue #358 PR D add-on — AsciiWave primitive.
// A travelling block-density wave (`░ ▒ ▓ █`) cycled via CSS @keyframes
// over an 8-frame steps() animation. No JS timer; aria-hidden; obeys
// prefers-reduced-motion.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import AsciiWave from "../AsciiWave.svelte";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(HERE, "../AsciiWave.svelte");

describe("AsciiWave (#358 add-on)", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(window, "setInterval");
    setTimeoutSpy = vi.spyOn(window, "setTimeout");
  });
  afterEach(() => {
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it("renders an element with class vc-ascii-wave and aria-hidden=true", () => {
    const { container } = render(AsciiWave);
    const root = container.querySelector(".vc-ascii-wave");
    expect(root).toBeTruthy();
    expect(root!.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not invoke setInterval or setTimeout on mount (CSS-only animation)", () => {
    render(AsciiWave);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("source defines a @keyframes block driving the wave frames via CSS content:", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    expect(src).toMatch(/@keyframes\s+vc-ascii-wave[^{]*\{[\s\S]*content:/);
  });

  it("source has a @media (prefers-reduced-motion: reduce) rule freezing the animation", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    expect(src).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    // Inside that block, the wave's animation must be set to none.
    const media = src.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\}\s*\}/,
    );
    expect(media).toBeTruthy();
    expect(media![0]).toMatch(/animation:\s*none/);
  });

  it("CREST constant uses only block-fill glyphs — no ASCII slashes, no braille", () => {
    // The wave's only source of glyph variation is the CREST constant;
    // every frame is built by sliding it across a `░` field. Asserting
    // directly on CREST is the regression guard for palette violations.
    // (A previous form scanned `content: "…"` literals, but the
    // component injects frames via inline CSS custom properties, so no
    // such literals exist and the scan was inert.)
    const src = readFileSync(SOURCE_PATH, "utf8");
    const crestMatch = src.match(/const\s+CREST\s*=\s*"([^"]*)"/);
    expect(crestMatch).toBeTruthy();
    const crest = crestMatch![1]!;
    expect(crest).not.toMatch(/[\\/]/);
    expect(crest).not.toMatch(/[⠀-⣿]/);
    expect(crest).toMatch(/^[░▒▓█]+$/);
  });

  it("source uses no braille characters (U+2800–U+28FF)", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    expect(src).not.toMatch(/[⠀-⣿]/);
  });
});
