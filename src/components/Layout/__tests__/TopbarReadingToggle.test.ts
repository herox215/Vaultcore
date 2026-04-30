/**
 * #388 — Mobile-only topbar pencil toggle for Reading Mode.
 *
 * Visibility matrix:
 *   - Hidden on desktop and tablet regardless of tab kind.
 *   - Hidden on mobile when no tab is active.
 *   - Hidden on mobile when the active tab does not support Reading Mode
 *     (graph / image / unsupported / text / canvas).
 *   - Visible on mobile when the active tab is markdown.
 *
 * Click behaviour:
 *   - Click flips the active tab's viewMode via tabStore.toggleViewMode.
 *   - data-mode flips between "edit" and "read" reactively.
 *
 * Per-tab persistence (T-top-9):
 *   - Toggle tab A to edit, switch active to B, switch back to A — A stays
 *     in edit and the toggle reflects A's state, not the most-recently-toggled
 *     tab's state.
 *
 * Test setup notes:
 *   - viewportStore is mocked once at module load with a controllable writable.
 *     We do NOT use vi.resetModules — Svelte 5 effect tracking is shared
 *     across the whole module graph and resetModules tears that lifecycle,
 *     producing `effect_orphan` errors in onMount / $effect.
 *   - `setViewportMode(mode)` swaps the mocked store's value between tests.
 *   - Each test re-renders TopbarReadingToggle so it reads the current mode
 *     during its onMount subscription.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import { writable, get } from "svelte/store";

// Hoisted: a single writable owned by the mock so every importer of
// viewportStore sees the same store instance across all tests.
const { viewportWritable } = vi.hoisted(() => ({
  viewportWritable: (() => {
    // Avoid top-of-file svelte import in vi.hoisted by deferring inside
    // the IIFE — vi.hoisted runs after svelte resolves.
    const { writable } = require("svelte/store");
    return writable({ mode: "desktop", isCoarsePointer: false });
  })(),
}));

vi.mock("../../../store/viewportStore", () => ({
  viewportStore: viewportWritable,
  createViewportStore: () => viewportWritable,
}));

function setViewportMode(mode: "desktop" | "tablet" | "mobile"): void {
  viewportWritable.set({ mode, isCoarsePointer: mode === "mobile" });
}

import { tabStore } from "../../../store/tabStore";
import TopbarReadingToggle from "../TopbarReadingToggle.svelte";

describe("TopbarReadingToggle visibility (#388)", () => {
  beforeEach(() => {
    tabStore._reset();
    setViewportMode("desktop");
  });

  afterEach(() => {
    cleanup();
  });

  it("hidden on desktop even when an active markdown tab exists", async () => {
    setViewportMode("desktop");
    tabStore.openTab("/v/note.md");
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on tablet even when an active markdown tab exists", async () => {
    setViewportMode("tablet");
    tabStore.openTab("/v/note.md");
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile when no tab is active", async () => {
    setViewportMode("mobile");
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for graph tabs", async () => {
    setViewportMode("mobile");
    tabStore.openGraphTab();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for image tabs", async () => {
    setViewportMode("mobile");
    tabStore.openFileTab("/v/photo.png", "image");
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for canvas tabs", async () => {
    setViewportMode("mobile");
    tabStore.openFileTab("/v/board.canvas", "canvas");
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for text-viewer tabs (.json / .txt / etc.)", async () => {
    setViewportMode("mobile");
    tabStore.openFileTab("/v/data.json", "text");
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for unsupported tabs", async () => {
    setViewportMode("mobile");
    tabStore.openFileTab("/v/blob.bin", "unsupported");
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("visible on mobile for active markdown tab in edit mode (data-mode='edit')", async () => {
    setViewportMode("mobile");
    tabStore.openTab("/v/note.md", "edit");
    const { container } = render(TopbarReadingToggle);
    await tick();
    const button = container.querySelector("[data-vc-topbar-reading-toggle]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-mode")).toBe("edit");
  });

  it("visible on mobile for active markdown tab in read mode (data-mode='read')", async () => {
    setViewportMode("mobile");
    tabStore.openTab("/v/note.md", "read");
    const { container } = render(TopbarReadingToggle);
    await tick();
    const button = container.querySelector("[data-vc-topbar-reading-toggle]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-mode")).toBe("read");
  });

  it("visible on mobile for tab with undefined viewMode (treated as edit)", async () => {
    setViewportMode("mobile");
    tabStore.openTab("/v/note.md");
    const { container } = render(TopbarReadingToggle);
    await tick();
    const button = container.querySelector("[data-vc-topbar-reading-toggle]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-mode")).toBe("edit");
  });
});

describe("TopbarReadingToggle click behaviour (#388)", () => {
  beforeEach(() => {
    tabStore._reset();
    setViewportMode("mobile");
  });

  afterEach(() => {
    cleanup();
  });

  it("click on edit-mode tab flips it to read and the data-mode updates", async () => {
    const tabId = tabStore.openTab("/v/note.md", "edit");
    const { container } = render(TopbarReadingToggle);
    await tick();

    const button = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("data-mode")).toBe("edit");

    await fireEvent.click(button);
    await tick();

    const tab = get(tabStore).tabs.find((t) => t.id === tabId);
    expect(tab?.viewMode).toBe("read");

    const buttonAfter = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    );
    expect(buttonAfter?.getAttribute("data-mode")).toBe("read");
  });

  it("click on read-mode tab flips it to edit and the data-mode updates", async () => {
    const tabId = tabStore.openTab("/v/note.md", "read");
    const { container } = render(TopbarReadingToggle);
    await tick();

    const button = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("data-mode")).toBe("read");

    await fireEvent.click(button);
    await tick();

    expect(get(tabStore).tabs.find((t) => t.id === tabId)?.viewMode).toBe("edit");

    const buttonAfter = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    );
    expect(buttonAfter?.getAttribute("data-mode")).toBe("edit");
  });

  it("per-tab persistence — toggle A, switch to B, switch back, A still in flipped mode", async () => {
    const idA = tabStore.openTab("/v/a.md", "edit");
    const idB = tabStore.openTab("/v/b.md", "edit");
    tabStore.activateTab(idA);

    const { container } = render(TopbarReadingToggle);
    await tick();

    let button = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("data-mode")).toBe("edit");
    await fireEvent.click(button);
    await tick();
    expect(
      container.querySelector("[data-vc-topbar-reading-toggle]")?.getAttribute("data-mode"),
    ).toBe("read");

    tabStore.activateTab(idB);
    await tick();
    expect(
      container.querySelector("[data-vc-topbar-reading-toggle]")?.getAttribute("data-mode"),
    ).toBe("edit");

    tabStore.activateTab(idA);
    await tick();
    expect(
      container.querySelector("[data-vc-topbar-reading-toggle]")?.getAttribute("data-mode"),
    ).toBe("read");

    const final = get(tabStore);
    expect(final.tabs.find((t) => t.id === idA)?.viewMode).toBe("read");
    expect(final.tabs.find((t) => t.id === idB)?.viewMode).toBe("edit");
  });
});
