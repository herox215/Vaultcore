// TDD for #253: at 10k flat rows the rendered DOM must contain ONLY the
// viewport slice + overscan, not all 10k rows. Without virtualization the
// previous sidebar blew past the 500 MB RAM budget and destroyed keystroke
// latency the moment the user scrolled.

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

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
}
import Sidebar from "../Sidebar.svelte";
import type { DirEntry } from "../../../types/tree";

const VAULT = "/tmp/test-vault";

function md(i: number): DirEntry {
  return {
    name: `note-${String(i).padStart(6, "0")}.md`,
    path: `${VAULT}/note-${String(i).padStart(6, "0")}.md`,
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

// Row height used by the virtualized renderer. Sidebar exposes this as a
// CSS var (`--vc-tree-row-height`, 28px) but we only need the rough order
// of magnitude here — the assertion just checks "orders of magnitude less
// than the full list".
const ROW_HEIGHT = 28;
const VIEWPORT_HEIGHT = 600; // typical sidebar column
const OVERSCAN = 10;

describe("Sidebar virtualization (#253)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
  });

  it("renders only viewport+overscan rows for a 10k-entry tree", async () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => md(i));
    (listDirectory as any).mockResolvedValue(entries);

    // jsdom elements report clientHeight === 0 — prime it via the getter so
    // Sidebar's ResizeObserver fallback picks up a realistic viewport height.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return VIEWPORT_HEIGHT;
      },
    });

    const { container } = render(Sidebar, { props: makeProps() });

    // Drain the vault-subscribe IIFE + loadRoot microtask chain.
    for (let i = 0; i < 15; i += 1) {
      await Promise.resolve();
      await tick();
    }

    const rows = container.querySelectorAll("[data-tree-row]");
    const viewportRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT); // ~22

    // Bound is viewport_rows + 2*overscan + a small fudge for boundary rounding.
    const upperBound = viewportRows + 2 * OVERSCAN + 10;
    expect(rows.length).toBeLessThanOrEqual(upperBound);

    // Sanity: at least the visible viewport is populated, so the test isn't
    // accidentally passing because nothing rendered.
    expect(rows.length).toBeGreaterThan(0);

    // And nowhere near the 10k-row count.
    expect(rows.length).toBeLessThan(200);
  });
});
