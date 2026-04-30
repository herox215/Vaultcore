/**
 * #388 — Breadcrumbs reading-mode toggle is hidden on mobile.
 *
 * Mobile users get a dedicated topbar pencil button (TopbarReadingToggle).
 * To avoid two toggles in the same surface, the existing Breadcrumbs
 * toggle from #63 hides itself when the viewport is mobile. Desktop and
 * tablet keep the breadcrumbs toggle unchanged.
 *
 * Test setup notes: see TopbarReadingToggle.test.ts header. We mock
 * viewportStore once at module load with a controllable writable rather
 * than using vi.resetModules — Svelte 5 effect tracking shares state
 * across the whole module graph and resetModules tears it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";

const { viewportWritable } = vi.hoisted(() => ({
  viewportWritable: (() => {
    const { writable } = require("svelte/store");
    return writable({ mode: "desktop", isCoarsePointer: false });
  })(),
}));

vi.mock("../../../store/viewportStore", () => ({
  viewportStore: viewportWritable,
  createViewportStore: () => viewportWritable,
}));

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
}));

import { vaultStore } from "../../../store/vaultStore";
import { tabStore } from "../../../store/tabStore";
import Breadcrumbs from "../Breadcrumbs.svelte";

function setViewportMode(mode: "desktop" | "tablet" | "mobile"): void {
  viewportWritable.set({ mode, isCoarsePointer: mode === "mobile" });
}

describe("Breadcrumbs reading-mode toggle visibility (#388)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    setViewportMode("desktop");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the toggle on desktop when viewMode is defined", async () => {
    setViewportMode("desktop");
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
    setViewportMode("mobile");
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
    setViewportMode("tablet");
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
