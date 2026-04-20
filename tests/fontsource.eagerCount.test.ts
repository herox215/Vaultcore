/**
 * fontsource.eagerCount — regression guard for issue #255.
 *
 * `src/main.ts` runs before Svelte mounts, so every eager `@fontsource/*`
 * CSS import pulls a woff2 binary onto the startup critical path. The
 * fix defers non-critical fonts behind a dynamic import triggered from
 * `settingsStore` when the user actually selects that family.
 *
 * This test caps eager @fontsource imports in `main.ts` at zero. If the
 * UI default ever becomes a non-system font on first paint, raise the cap
 * to 1 and add a targeted assertion that only that single weight is loaded.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAIN_TS = resolve(__dirname, "..", "src", "main.ts");

/** All non-commented lines that begin a static `import … "@fontsource/*"` statement. */
function countEagerFontsourceImports(source: string): number {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const lines = withoutBlockComments.split(/\r?\n/);
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("//")) continue;
    // Static import forms: `import "@fontsource/..."` or `import x from "@fontsource/..."`.
    if (/^import\s+(?:[^'"]+\s+from\s+)?["']@fontsource\//.test(line)) {
      count += 1;
    }
  }
  return count;
}

describe("issue #255 — main.ts eager @fontsource imports", () => {
  it("keeps zero @fontsource CSS on the startup critical path", () => {
    const source = readFileSync(MAIN_TS, "utf8");
    const eager = countEagerFontsourceImports(source);
    expect(eager).toBeLessThanOrEqual(0);
  });
});
