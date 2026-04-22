// TDD for #253: revealing a path inside a collapsed ancestor chain must
//   1. Call listDirectory for each ancestor in order (top → down)
//   2. Re-flatten once the results land
//   3. Scroll the target row into view (scrollIntoView invoked)
//
// The old TreeNode architecture drove expansion implicitly via the
// persisted expanded-paths prop; with the flat architecture the Sidebar is
// the sole owner of this sequencing.

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

function dir(name: string, path: string): DirEntry {
  return { name, path, is_dir: true, is_symlink: false, is_md: false, modified: null, created: null };
}
function md(name: string, path: string): DirEntry {
  return { name, path, is_dir: false, is_symlink: false, is_md: true, modified: null, created: null };
}

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

describe("Sidebar reveal sequencing (#253)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("expands ancestors, calls listDirectory in order, then scrolls the target into view", async () => {
    const notes = dir("notes", `${VAULT}/notes`);
    const daily = dir("daily", `${VAULT}/notes/daily`);
    const today = md("today.md", `${VAULT}/notes/daily/today.md`);

    (listDirectory as any).mockImplementation(async (path: string) => {
      if (path === VAULT) return [notes];
      if (path === notes.path) return [daily];
      if (path === daily.path) return [today];
      return [];
    });

    // Stub scrollIntoView globally — jsdom doesn't implement it.
    const scrollSpy = vi.fn();
    (window as any).HTMLElement.prototype.scrollIntoView = scrollSpy;

    // Prime clientHeight so the virtualized window has a real viewport
    // (#336 B2: reveal bails early on 0-height scrollers).
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return 600; },
    });

    render(Sidebar, { props: makeProps() });

    // Flush the initial vault-subscribe + root listDirectory.
    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    // Reveal a path inside a collapsed ancestor chain. The target itself is
    // a file two folders deep — Sidebar must expand notes → daily in order,
    // wait for each listDirectory, then scroll.
    treeRevealStore.requestReveal("notes/daily/today.md");

    // Flush the reveal pipeline; each ancestor adds an async listDirectory.
    for (let i = 0; i < 60; i += 1) { await Promise.resolve(); await tick(); }

    const calls = (listDirectory as any).mock.calls.map((c: any[]) => c[0] as string);

    // Root list is always called first (on vault open). Then the reveal
    // sequence must include notes then daily, in that order.
    const notesIdx = calls.indexOf(notes.path);
    const dailyIdx = calls.indexOf(daily.path);
    expect(notesIdx).toBeGreaterThanOrEqual(0);
    expect(dailyIdx).toBeGreaterThan(notesIdx);

    // Target row scrolled into view.
    expect(scrollSpy).toHaveBeenCalled();
  });
});
