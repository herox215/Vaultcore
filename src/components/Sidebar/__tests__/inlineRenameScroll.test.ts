// TDD for #253: when a user renames a row far down the list, scrolling the
// virtual list must not destroy the rename input. The flat renderer must
// key rows by `path` so the recycler reuses the same DOM node for the
// rename target — otherwise typing `tab` + scroll = lost focus = data loss.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
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

const ROW_HEIGHT = 28;
const VIEWPORT_HEIGHT = 400;

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

describe("Inline rename survives virtual-list scroll (#253)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();

    // Prime jsdom viewport height.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return VIEWPORT_HEIGHT;
      },
    });
  });

  it("keeps rename input focused when the user scrolls far enough to recycle the row", async () => {
    // Large list so row N still is inside the window at scrollTop=0 but
    // would be OUT of the window after we scroll significantly.
    const entries = Array.from({ length: 500 }, (_, i) => md(i));
    (listDirectory as any).mockResolvedValue(entries);

    const { container } = render(Sidebar, { props: makeProps() });

    for (let i = 0; i < 15; i += 1) { await Promise.resolve(); await tick(); }

    // Find a row we know is inside the initial viewport (first visible row).
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-tree-row]"));
    expect(rows.length).toBeGreaterThan(0);
    const target = rows[0]!;
    const targetPath = target.getAttribute("data-tree-row")!;

    // Open the context menu and click Rename.
    const row = target.querySelector(".vc-tree-row") as HTMLElement;
    await fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    await tick();
    const renameBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".vc-context-item"))
      .find((b) => b.textContent?.trim() === "Rename");
    expect(renameBtn).toBeTruthy();
    await fireEvent.click(renameBtn!);
    await tick();

    const input = container.querySelector<HTMLInputElement>(".vc-rename-input");
    expect(input).toBeTruthy();
    // Input should have focus immediately after rename starts (InlineRename onMount).
    expect(document.activeElement).toBe(input);

    // Scroll the virtual list container far enough that the viewport no
    // longer covers row 0. We scroll the scroll-host directly — the
    // virtualized renderer listens to scroll on this element.
    const scroller = container.querySelector<HTMLElement>(".vc-sidebar-tree");
    expect(scroller).toBeTruthy();
    scroller!.scrollTop = 1000; // push ~36 rows down — far past overscan
    await fireEvent.scroll(scroller!);
    for (let i = 0; i < 5; i += 1) await tick();

    // After the scroll, the rename row is outside the viewport, so the
    // virtualized renderer may have removed it from the DOM. That's fine —
    // but if it's still in the DOM (because the rename row is pinned or
    // overscanned), its focus must survive. We check the contract
    // explicitly: if a rename input still exists in the DOM, it must be
    // the focused element. Otherwise (row got recycled out), the caller is
    // responsible for re-opening the rename after scroll-back; document
    // that by allowing either.
    const reinput = container.querySelector<HTMLInputElement>(".vc-rename-input");
    if (reinput) {
      // Row still present → focus must survive (keyed recycler, no destroy).
      expect(document.activeElement).toBe(reinput);
      // And the input is still pointing at the same target path.
      const reRow = reinput.closest("[data-tree-row]");
      expect(reRow?.getAttribute("data-tree-row")).toBe(targetPath);
    } else {
      // The renderer decided the rename row was far out of window and
      // removed it. This is only acceptable if the flat data model still
      // tracks it — the Sidebar must pin the renaming row so it survives
      // scroll. Fail loudly so we notice during the TDD run.
      throw new Error(
        "Rename row was recycled out of the DOM — virtual list must pin the currently-renaming row so focus is never lost.",
      );
    }
  });
});
