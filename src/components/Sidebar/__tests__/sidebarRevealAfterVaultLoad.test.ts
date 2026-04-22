// Regression for PR #336 blocker B1 — reveal fired in the same tick as
// vault load must NOT silently no-op because a `$derived` value read from
// inside the store-subscription callback is stale.
//
// Scenario: user clicks a backlink / launches the app with a startup
// reveal request queued. The vault loads (rootEntries populated via async
// listDirectory) and the reveal token fires together. `performReveal`
// must find the target row and scroll to it instead of bailing because
// `flatRows.findIndex(...)` returned -1 from a stale `$derived`.

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

function md(name: string, path: string): DirEntry {
  return {
    name,
    path,
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

describe("Sidebar reveal right after vault load (#336 B1)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    // Do NOT pre-setReady here — we want the vault transition to happen
    // immediately after render, so reveal-after-load races the $derived
    // recompute the same way a real startup reveal does.
    vi.clearAllMocks();
  });

  it("scrolls the target into view when the reveal fires before $derived has caught up", async () => {
    const targetIdx = 150;
    const entries: DirEntry[] = Array.from({ length: 200 }, (_, i) => {
      const name = `note-${String(i).padStart(3, "0")}.md`;
      return md(name, `${VAULT}/${name}`);
    });
    const target = entries[targetIdx]!;

    // listDirectory resolves *eagerly* — before the reveal subscription
    // has had a chance to settle, so the `$derived` that reads rootEntries
    // may still be serving its previous (empty) snapshot when `performReveal`
    // first reads `flatRows`.
    (listDirectory as any).mockImplementation(async (path: string) => {
      if (path === VAULT) return entries;
      return [];
    });

    const scrollSpy = vi.fn();
    (window as any).HTMLElement.prototype.scrollIntoView = scrollSpy;

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return 600; },
    });

    const { container } = render(Sidebar, { props: makeProps() });

    // Flip the vault ready AFTER mount — this fires the vault subscription
    // which triggers the async `rootEntries = ...` assignment, and then we
    // immediately fire the reveal before `$derived` has recomputed.
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    treeRevealStore.requestReveal(target.name);

    // Flush everything.
    for (let i = 0; i < 80; i += 1) { await Promise.resolve(); await tick(); }

    const scroller = container.querySelector<HTMLElement>(".vc-sidebar-tree");
    expect(scroller).toBeTruthy();
    // B1 guard: the reveal must resolve the target and scroll to it.
    expect(scroller!.scrollTop).toBeGreaterThan(1000);
    expect(scrollSpy).toHaveBeenCalled();
  });
});
