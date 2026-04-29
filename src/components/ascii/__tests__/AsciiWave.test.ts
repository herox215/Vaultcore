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

  it("source palette is block-fills and box-drawing only — no ASCII slashes in any content: declaration", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    const declarations = src.match(/content:\s*"([^"]*)"/g) ?? [];
    // The component may pass frame strings via CSS custom properties;
    // the @keyframes block then references content: var(--vc-wave-fN).
    // In either form, the literal `content: "..."` declarations that
    // do exist must not contain ASCII slashes.
    for (const decl of declarations) {
      expect(decl).not.toMatch(/[\\/]/);
    }
  });

  it("source uses no braille characters (U+2800–U+28FF)", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    expect(src).not.toMatch(/[⠀-⣿]/);
  });
});
