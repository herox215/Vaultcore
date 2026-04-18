// #176 — frosted-glass modal surfaces.
//
// The ticket's core contract: every top-level dialog shares a SINGLE pair of
// utility classes (`.vc-modal-scrim`, `.vc-modal-surface`) so the blur +
// translucency aren't duplicated per component. These tests guard that
// contract at the source level — that's stronger than runtime-classList
// assertions for a pure CSS refactor and doesn't require bringing up eight
// different component render fixtures with their respective stores.
//
// Three things are verified:
//   1. The global tokens + utility classes exist in tailwind.css.
//   2. Every modal component's markup applies the utility alongside the
//      existing `.vc-*-backdrop` / `.vc-*-modal` class.
//   3. No modal component's scoped <style> block still sets `background`,
//      `position: fixed`, or `inset: 0` on the scrim / surface selector —
//      those now come exclusively from the shared utility.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

/**
 * Extract the declaration block for a single CSS selector. We only match the
 * exact selector (no descendant combinators like `.vc-settings-modal :global`)
 * so the check doesn't bleed into unrelated rules in the same file.
 */
function extractRuleBlock(css: string, selector: string): string | null {
  // Match "selector {...}" where selector stands on its own at the start of a
  // rule. Escape dots for the regex.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[}\\s])(${escaped})\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[2] ?? null : null;
}

// Scrim + surface pairs per modal file.
const MODAL_PAIRS: Array<{
  file: string;
  scrim: string;
  surface: string;
}> = [
  {
    file: "src/components/Search/OmniSearch.svelte",
    scrim: ".vc-quick-switcher-backdrop",
    surface: ".vc-quick-switcher-modal",
  },
  {
    file: "src/components/CommandPalette/CommandPalette.svelte",
    scrim: ".vc-command-palette-backdrop",
    surface: ".vc-command-palette-modal",
  },
  {
    file: "src/components/Settings/SettingsModal.svelte",
    scrim: ".vc-settings-backdrop",
    surface: ".vc-settings-modal",
  },
  {
    file: "src/components/Settings/SettingsModal.svelte",
    scrim: ".vc-conflict-backdrop",
    surface: ".vc-conflict-modal",
  },
  {
    file: "src/components/TemplatePicker/TemplatePicker.svelte",
    scrim: ".vc-tp-backdrop",
    surface: ".vc-tp-modal",
  },
  {
    file: "src/components/common/UrlInputModal.svelte",
    scrim: ".vc-url-modal-backdrop",
    surface: ".vc-url-modal",
  },
  {
    file: "src/components/Sidebar/TreeNode.svelte",
    scrim: ".vc-confirm-overlay",
    surface: ".vc-confirm-dialog",
  },
];

describe("frosted-glass modal theming (#176)", () => {
  describe("tailwind.css defines the shared tokens and utility classes", () => {
    const css = read("src/styles/tailwind.css");

    it("defines --color-modal-surface in both light and dark themes", () => {
      // Token must appear at least twice — once in the light block, once in
      // the dark override. A single definition means one theme is untuned.
      const matches = css.match(/--color-modal-surface\s*:/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("defines --color-modal-scrim", () => {
      expect(css).toMatch(/--color-modal-scrim\s*:/);
    });

    it("defines --modal-blur-radius", () => {
      expect(css).toMatch(/--modal-blur-radius\s*:/);
    });

    it("declares the .vc-modal-scrim utility with the scrim bg", () => {
      const block = extractRuleBlock(css, ".vc-modal-scrim");
      expect(block).not.toBeNull();
      expect(block!).toMatch(/background\s*:\s*var\(--color-modal-scrim\)/);
      expect(block!).toMatch(/position\s*:\s*fixed/);
      expect(block!).toMatch(/inset\s*:\s*0/);
    });

    it("declares the .vc-modal-surface utility with backdrop-filter blur", () => {
      const block = extractRuleBlock(css, ".vc-modal-surface");
      expect(block).not.toBeNull();
      expect(block!).toMatch(/background\s*:\s*var\(--color-modal-surface\)/);
      expect(block!).toMatch(
        /backdrop-filter\s*:\s*blur\(var\(--modal-blur-radius\)\)/,
      );
      // Vendor prefix for older WebKit is load-bearing on Linux/Safari.
      expect(block!).toMatch(/-webkit-backdrop-filter/);
    });

    it("includes an @supports fallback for browsers without backdrop-filter", () => {
      expect(css).toMatch(
        /@supports\s+not\s*\(\s*backdrop-filter\s*:/,
      );
    });

    it("does NOT put backdrop-filter on the scrim (avoids double-blur through the surface)", () => {
      const block = extractRuleBlock(css, ".vc-modal-scrim");
      expect(block).not.toBeNull();
      expect(block!).not.toMatch(/backdrop-filter/);
    });
  });

  describe.each(MODAL_PAIRS)(
    "modal contract: $file [$scrim / $surface]",
    ({ file, scrim, surface }) => {
      const src = read(file);

      it(`${scrim} element carries the vc-modal-scrim utility class`, () => {
        const needle = scrim.slice(1); // strip leading "."
        const re = new RegExp(
          `class=\\"[^\\"]*\\b${needle}\\b[^\\"]*\\bvc-modal-scrim\\b` +
            `|class=\\"[^\\"]*\\bvc-modal-scrim\\b[^\\"]*\\b${needle}\\b`,
        );
        expect(src).toMatch(re);
      });

      it(`${surface} element carries the vc-modal-surface utility class`, () => {
        const needle = surface.slice(1);
        const re = new RegExp(
          `class=\\"[^\\"]*\\b${needle}\\b[^\\"]*\\bvc-modal-surface\\b` +
            `|class=\\"[^\\"]*\\bvc-modal-surface\\b[^\\"]*\\b${needle}\\b`,
        );
        expect(src).toMatch(re);
      });

      it(`scoped style for ${scrim} no longer redeclares background / position / inset`, () => {
        const block = extractRuleBlock(src, scrim);
        expect(block).not.toBeNull();
        expect(block!).not.toMatch(/background\s*:/);
        expect(block!).not.toMatch(/position\s*:\s*fixed/);
        expect(block!).not.toMatch(/inset\s*:\s*0/);
      });

      it(`scoped style for ${surface} no longer redeclares background`, () => {
        const block = extractRuleBlock(src, surface);
        expect(block).not.toBeNull();
        // Surface keeps its own layout (top/left/width/shadow) — only
        // background is off-limits, since it now comes from the utility.
        expect(block!).not.toMatch(/background\s*:\s*var\(--color-surface\)/);
      });
    },
  );
});
