/**
 * #388 — Breadcrumbs reading-mode toggle is hidden on mobile.
 *
 * Mobile users get a dedicated topbar pencil button (rendered in
 * VaultLayout). To avoid two toggles in the same surface, the existing
 * Breadcrumbs toggle from #63 hides itself when the viewport is mobile.
 * Desktop and tablet keep the breadcrumbs toggle unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import { readable } from "svelte/store";

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
}));

async function loadBreadcrumbs(
  mode: "desktop" | "tablet" | "mobile",
): Promise<{ Breadcrumbs: any; vaultStore: any; tabStore: any }> {
  vi.resetModules();
  vi.doMock("../../../store/viewportStore", () => ({
    viewportStore: readable({ mode, isCoarsePointer: mode === "mobile" }),
  }));
  const { vaultStore } = await import("../../../store/vaultStore");
  const { tabStore } = await import("../../../store/tabStore");
  const Breadcrumbs = (await import("../Breadcrumbs.svelte")).default;
  return { Breadcrumbs, vaultStore, tabStore };
}

describe("Breadcrumbs reading-mode toggle visibility (#388)", () => {
  beforeEach(() => {});

  afterEach(() => {
    cleanup();
    vi.doUnmock("../../../store/viewportStore");
  });

  it("renders the toggle on desktop when viewMode is defined", async () => {
    const { Breadcrumbs, vaultStore, tabStore } = await loadBreadcrumbs("desktop");
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["folder/note.md"],
      fileCount: 1,
    });
    const tabId = tabStore.openTab("/vault/folder/note.md");
    await tick();
    const { container } = render(Breadcrumbs, {
      props: {
        filePath: "/vault/folder/note.md",
        tabId,
        viewMode: "edit" as const,
      },
    });
    await tick();
    expect(container.querySelector(".vc-breadcrumbs-mode-toggle")).not.toBeNull();
  });

  it("hides the toggle on mobile even when viewMode is defined", async () => {
    const { Breadcrumbs, vaultStore, tabStore } = await loadBreadcrumbs("mobile");
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["folder/note.md"],
      fileCount: 1,
    });
    const tabId = tabStore.openTab("/vault/folder/note.md");
    await tick();
    const { container } = render(Breadcrumbs, {
      props: {
        filePath: "/vault/folder/note.md",
        tabId,
        viewMode: "edit" as const,
      },
    });
    await tick();
    expect(container.querySelector(".vc-breadcrumbs-mode-toggle")).toBeNull();
  });

  it("renders the toggle on tablet (tablet inherits the desktop default)", async () => {
    const { Breadcrumbs, vaultStore, tabStore } = await loadBreadcrumbs("tablet");
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["folder/note.md"],
      fileCount: 1,
    });
    const tabId = tabStore.openTab("/vault/folder/note.md");
    await tick();
    const { container } = render(Breadcrumbs, {
      props: {
        filePath: "/vault/folder/note.md",
        tabId,
        viewMode: "read" as const,
      },
    });
    await tick();
    expect(container.querySelector(".vc-breadcrumbs-mode-toggle")).not.toBeNull();
  });
});
