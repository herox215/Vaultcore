// Regression for PR #336 blocker B2 — reveal against a 0-height scroller
// (collapsed sidebar / pre-layout mount) must stash the path and fire once
// the scroller has a real clientHeight.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  updateLinksAfterRename: vi.fn(),
  getBacklinks: vi.fn().mockResolvedValue([]),
  loadBookmarks: vi.fn().mockResolvedValue([]),
  saveBookmarks: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn(),
  tagsList: vi.fn().mockResolvedValue([]),
  searchTagPaths: vi.fn().mockResolvedValue([]),
  renameFile: vi.fn(),
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
}));

import { listDirectory } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { treeRevealStore } from "../../../store/treeRevealStore";
import Sidebar from "../Sidebar.svelte";
import type { DirEntry } from "../../../types/tree";

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
}

const VAULT = "/tmp/test-vault";

function md(i: number): DirEntry {
  const name = `note-${String(i).padStart(3, "0")}.md`;
  return {
    name,
    path: `${VAULT}/${name}`,
    is_dir: false,
    is_symlink: false,
    is_md: true,
    modified: null,
    created: null,
  };
}

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

describe("Sidebar reveal when scroller has 0 height (#336 B2)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("stashes the pending reveal and dispatches it once the scroller has height", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => md(i));
    const target = entries[80]!;
    (listDirectory as any).mockResolvedValue(entries);

    const scrollSpy = vi.fn();
    (window as any).HTMLElement.prototype.scrollIntoView = scrollSpy;

    // Simulate a collapsed sidebar: clientHeight reads 0.
    let simulatedHeight = 0;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return simulatedHeight; },
    });

    // Capture the ResizeObserver callback so we can trigger it manually once
    // the "sidebar" gets its layout height.
    let resizeCb: ((entries: ResizeObserverEntry[], observer: ResizeObserver) => void) | null = null;
    class FakeResizeObserver {
      constructor(cb: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void) {
        resizeCb = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    render(Sidebar, { props: makeProps() });

    // Drain initial load — at this point the scroller has 0 height.
    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    // Fire the reveal while height is 0.
    treeRevealStore.requestReveal(target.name);
    for (let i = 0; i < 30; i += 1) { await Promise.resolve(); await tick(); }

    // With a 0-height scroller, scrollIntoView must NOT have been called yet.
    // (The viewport window is empty, so the target row isn't mounted.)
    expect(scrollSpy).not.toHaveBeenCalled();

    // Now the sidebar gets a real height — e.g. the user expands it or the
    // layout finally resolves. The stashed reveal should fire.
    simulatedHeight = 600;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (resizeCb as any)?.([], {} as ResizeObserver);

    for (let i = 0; i < 60; i += 1) { await Promise.resolve(); await tick(); }

    // B2 guard: pending reveal drained once the scroller had a real height.
    expect(scrollSpy).toHaveBeenCalled();
  });
});
