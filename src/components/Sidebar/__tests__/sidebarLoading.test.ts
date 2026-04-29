// Issue #358 PR B — sidebar loading state.
// While the vault tree is loading, the placeholder row must show an
// AsciiSpinner alongside the literal text "Loading", and the container
// must surface role="status" + aria-label="Loading vault tree" so screen
// readers announce it.

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
import Sidebar from "../Sidebar.svelte";

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

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

const VAULT = "/tmp/sidebar-loading-vault";

describe("Sidebar loading state (#358)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    vaultStore.reset();
    bookmarksStore.reset();
    vi.clearAllMocks();
  });

  it("shows an AsciiSpinner + 'Loading' text while listDirectory is in flight", async () => {
    // listDirectory never resolves — keeps the loading flag on.
    (listDirectory as any).mockImplementation(() => new Promise(() => {}));
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });

    const { container } = render(Sidebar, { props: makeProps() });
    await tick();
    await Promise.resolve();
    await tick();

    const status = container.querySelector(".vc-sidebar-status");
    expect(status).toBeTruthy();
    expect(status!.querySelector(".vc-ascii-spinner")).toBeTruthy();
    expect(status!.textContent).toMatch(/Loading/);
  });

  it("surfaces role=status + aria-label on the loading container for screen readers", async () => {
    (listDirectory as any).mockImplementation(() => new Promise(() => {}));
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });

    const { container } = render(Sidebar, { props: makeProps() });
    await tick();
    await Promise.resolve();
    await tick();

    const status = container.querySelector(".vc-sidebar-status");
    expect(status).toBeTruthy();
    expect(status!.getAttribute("role")).toBe("status");
    expect(status!.getAttribute("aria-label")).toBe("Loading vault tree");
  });
});
