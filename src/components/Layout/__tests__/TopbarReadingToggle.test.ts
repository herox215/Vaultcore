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
 *   - Icon flips from BookOpen (in edit) to Pencil (in read), and back.
 *
 * Per-tab persistence (T-top-9):
 *   - Toggle tab A to edit, switch active to B, switch back to A — A stays
 *     in edit and the icon reflects A's state, not the most-recently-toggled
 *     tab's state.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import { readable } from "svelte/store";

vi.mock("../../../ipc/commands", () => ({}));

async function loadToggle(
  mode: "desktop" | "tablet" | "mobile",
): Promise<{
  TopbarReadingToggle: any;
  tabStore: typeof import("../../../store/tabStore").tabStore;
}> {
  vi.resetModules();
  vi.doMock("../../../store/viewportStore", () => ({
    viewportStore: readable({ mode, isCoarsePointer: mode === "mobile" }),
  }));
  const { tabStore } = await import("../../../store/tabStore");
  const TopbarReadingToggle = (await import("../TopbarReadingToggle.svelte")).default;
  return { TopbarReadingToggle, tabStore };
}

describe("TopbarReadingToggle visibility (#388)", () => {
  afterEach(() => {
    cleanup();
    vi.doUnmock("../../../store/viewportStore");
  });

  it("hidden on desktop even when an active markdown tab exists", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("desktop");
    tabStore._reset();
    tabStore.openTab("/v/note.md");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on tablet even when an active markdown tab exists", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("tablet");
    tabStore._reset();
    tabStore.openTab("/v/note.md");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile when no tab is active", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for graph tabs", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openGraphTab();
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for image tabs", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openFileTab("/v/photo.png", "image");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for canvas tabs", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openFileTab("/v/board.canvas", "canvas");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for text-viewer tabs (.json / .txt / etc.)", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openFileTab("/v/data.json", "text");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("hidden on mobile for unsupported tabs", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openFileTab("/v/blob.bin", "unsupported");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")).toBeNull();
  });

  it("visible on mobile for active markdown tab in edit mode (data-mode='edit')", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openTab("/v/note.md", "edit");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    const button = container.querySelector("[data-vc-topbar-reading-toggle]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-mode")).toBe("edit");
  });

  it("visible on mobile for active markdown tab in read mode (data-mode='read')", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openTab("/v/note.md", "read");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    const button = container.querySelector("[data-vc-topbar-reading-toggle]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-mode")).toBe("read");
  });

  it("visible on mobile for tab with undefined viewMode (treated as edit)", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    tabStore.openTab("/v/note.md");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();
    const button = container.querySelector("[data-vc-topbar-reading-toggle]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-mode")).toBe("edit");
  });
});

describe("TopbarReadingToggle click behaviour (#388)", () => {
  afterEach(() => {
    cleanup();
    vi.doUnmock("../../../store/viewportStore");
  });

  it("click on edit-mode tab flips it to read and the data-mode updates", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    const tabId = tabStore.openTab("/v/note.md", "edit");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();

    const button = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("data-mode")).toBe("edit");

    await fireEvent.click(button);
    await tick();

    const after = await import("svelte/store").then((m) => m.get(tabStore));
    const tab = after.tabs.find((t) => t.id === tabId);
    expect(tab?.viewMode).toBe("read");

    const buttonAfter = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    );
    expect(buttonAfter?.getAttribute("data-mode")).toBe("read");
  });

  it("click on read-mode tab flips it to edit and the data-mode updates", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    const tabId = tabStore.openTab("/v/note.md", "read");
    await tick();
    const { container } = render(TopbarReadingToggle);
    await tick();

    const button = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("data-mode")).toBe("read");

    await fireEvent.click(button);
    await tick();

    const after = await import("svelte/store").then((m) => m.get(tabStore));
    expect(after.tabs.find((t) => t.id === tabId)?.viewMode).toBe("edit");

    const buttonAfter = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    );
    expect(buttonAfter?.getAttribute("data-mode")).toBe("edit");
  });

  it("per-tab persistence — toggle A, switch to B, switch back, A still in flipped mode", async () => {
    const { TopbarReadingToggle, tabStore } = await loadToggle("mobile");
    tabStore._reset();
    const idA = tabStore.openTab("/v/a.md", "edit");
    const idB = tabStore.openTab("/v/b.md", "edit");
    tabStore.activateTab(idA);
    await tick();

    const { container } = render(TopbarReadingToggle);
    await tick();

    let button = container.querySelector(
      "[data-vc-topbar-reading-toggle]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("data-mode")).toBe("edit");
    await fireEvent.click(button);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")
      ?.getAttribute("data-mode")).toBe("read");

    tabStore.activateTab(idB);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")
      ?.getAttribute("data-mode")).toBe("edit");

    tabStore.activateTab(idA);
    await tick();
    expect(container.querySelector("[data-vc-topbar-reading-toggle]")
      ?.getAttribute("data-mode")).toBe("read");

    const final = await import("svelte/store").then((m) => m.get(tabStore));
    expect(final.tabs.find((t) => t.id === idA)?.viewMode).toBe("read");
    expect(final.tabs.find((t) => t.id === idB)?.viewMode).toBe("edit");
  });
});
