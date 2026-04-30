/**
 * #388 — `defaultViewModeForViewport()` reads `viewportStore` once and
 * returns the viewport-aware default `viewMode` for newly-opened markdown
 * tabs. Mobile → "read", desktop/tablet → "edit".
 *
 * Module-level mock of `viewportStore` per test, with `vi.resetModules()`
 * between tests so each dynamic import re-evaluates the helper against the
 * freshly-installed readable. This works fine here (pure function, no
 * Svelte 5 component runtime); the same pattern is unsafe for component
 * tests (see `TopbarReadingToggle.test.ts` header for the gory details).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readable } from "svelte/store";

describe("defaultViewModeForViewport (#388)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../store/viewportStore");
  });

  async function loadHelper(
    mode: "desktop" | "tablet" | "mobile",
  ): Promise<() => "edit" | "read"> {
    vi.doMock("../../store/viewportStore", () => ({
      viewportStore: readable({ mode, isCoarsePointer: mode === "mobile" }),
    }));
    const { defaultViewModeForViewport } = await import("../viewport");
    return defaultViewModeForViewport;
  }

  it("returns 'read' on mobile", async () => {
    const fn = await loadHelper("mobile");
    expect(fn()).toBe("read");
  });

  it("returns 'edit' on desktop", async () => {
    const fn = await loadHelper("desktop");
    expect(fn()).toBe("edit");
  });

  it("returns 'edit' on tablet (tablet keeps the desktop default)", async () => {
    const fn = await loadHelper("tablet");
    expect(fn()).toBe("edit");
  });
});
