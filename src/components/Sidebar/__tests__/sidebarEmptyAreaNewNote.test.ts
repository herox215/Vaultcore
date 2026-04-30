// Empty-tree-area long-press → "New note here" → vault-root note (#387).
// On the mobile profile, a long-press on the tree container itself (not on
// any row) opens a single-item menu that creates a note in the vault root.
// Strict-target filtering on the action ensures bubbling pointerdowns from
// row descendants do NOT trigger the wrapper menu.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
  createFile: vi.fn().mockResolvedValue("/tmp/test-vault/Untitled.md"),
  createFolder: vi.fn(),
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  updateLinksAfterRename: vi.fn(),
  getBacklinks: vi.fn().mockResolvedValue([]),
  loadBookmarks: vi.fn().mockResolvedValue([]),
  saveBookmarks: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn(),
  renameFile: vi.fn(),
}));
vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
}));

import { createFile } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import Sidebar from "../Sidebar.svelte";

const VAULT = "/tmp/test-vault";

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerType?: string } = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "touch", configurable: true });
  return ev;
}

describe("Sidebar empty-tree-area long-press → New note here (#387)", () => {
  beforeEach(() => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.useFakeTimers();
    vi.mocked(createFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("long-press on the tree wrapper opens the empty-area menu", async () => {
    const { container } = render(Sidebar, {
      props: {
        selectedPath: null,
        onSelect: vi.fn(),
        onOpenFile: vi.fn(),
        onOpenContentSearch: vi.fn(),
      },
    });
    await tick();

    const tree = container.querySelector(".vc-sidebar-tree") as HTMLElement;
    expect(tree).toBeTruthy();

    // Direct dispatch on the tree → event.target === tree (strict mode passes).
    tree.dispatchEvent(pointerEvent("pointerdown", { clientX: 50, clientY: 60 }));
    vi.advanceTimersByTime(500);
    await tick();

    const menu = container.querySelector(".vc-sidebar-empty-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.textContent).toContain("New note here");
  });

  it("clicking the empty-area 'New note here' creates a note in the vault root", async () => {
    const { container } = render(Sidebar, {
      props: {
        selectedPath: null,
        onSelect: vi.fn(),
        onOpenFile: vi.fn(),
        onOpenContentSearch: vi.fn(),
      },
    });
    await tick();

    const tree = container.querySelector(".vc-sidebar-tree") as HTMLElement;
    tree.dispatchEvent(pointerEvent("pointerdown", { clientX: 5, clientY: 5 }));
    vi.advanceTimersByTime(500);
    await tick();

    const newNote = container.querySelector(
      ".vc-sidebar-empty-menu button",
    ) as HTMLButtonElement;
    expect(newNote).toBeTruthy();
    await fireEvent.click(newNote);
    await vi.runAllTimersAsync();
    await tick();

    expect(createFile).toHaveBeenCalledWith(VAULT, "");
  });
});
