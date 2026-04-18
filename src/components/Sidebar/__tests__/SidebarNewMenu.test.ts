// #145 — unit tests for the sidebar header "+ New ▾" split/dropdown.
// The split button exposes canvas creation without right-clicking a folder
// and keeps the primary click fast-path for new notes intact.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
  createFile: vi.fn().mockResolvedValue("/tmp/test-vault/Untitled.canvas"),
  createFolder: vi.fn().mockResolvedValue("/tmp/test-vault/new-folder"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  loadBookmarks: vi.fn().mockResolvedValue([]),
  saveBookmarks: vi.fn().mockResolvedValue(undefined),
  tagsList: vi.fn().mockResolvedValue([]),
  searchTagPaths: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
}));

import { vaultStore } from "../../../store/vaultStore";
import { tabStore } from "../../../store/tabStore";
import Sidebar from "../Sidebar.svelte";
import * as ipcCommands from "../../../ipc/commands";

const VAULT = "/tmp/test-vault";

function makeProps() {
  return {
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenContentSearch: vi.fn(),
  };
}

describe("Sidebar header New split/dropdown (#145)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
  });

  it("primary click of the new button creates a note without opening the menu", async () => {
    const { container } = render(Sidebar, { props: makeProps() });
    await tick();
    const primary = container.querySelector('[data-testid="sidebar-new-note"]') as HTMLButtonElement;
    expect(primary).toBeTruthy();

    await fireEvent.click(primary);
    await tick();

    // Menu should not appear when primary is clicked — fast path.
    expect(container.querySelector('[data-testid="sidebar-new-menu"]')).toBeNull();
    expect(ipcCommands.createFile).toHaveBeenCalledWith(VAULT, "");
  });

  it("chevron toggle reveals New note and New canvas entries", async () => {
    const { container, getByText } = render(Sidebar, { props: makeProps() });
    await tick();
    const chevron = container.querySelector('[data-testid="sidebar-new-menu-toggle"]') as HTMLButtonElement;

    await fireEvent.click(chevron);
    await tick();

    const menu = container.querySelector('[data-testid="sidebar-new-menu"]');
    expect(menu).toBeTruthy();
    expect(getByText("New note")).toBeTruthy();
    expect(getByText("New canvas")).toBeTruthy();
  });

  it("New canvas item creates a seeded .canvas file and opens it as a canvas tab", async () => {
    const openFileTabSpy = vi.spyOn(tabStore, "openFileTab");
    const { container } = render(Sidebar, { props: makeProps() });
    await tick();

    const chevron = container.querySelector('[data-testid="sidebar-new-menu-toggle"]') as HTMLButtonElement;
    await fireEvent.click(chevron);
    await tick();

    const canvasItem = container.querySelector('[data-testid="sidebar-new-menu-canvas"]') as HTMLButtonElement;
    await fireEvent.click(canvasItem);
    // handleNewCanvas awaits createFile → writeFile → loadRoot before it
    // calls openFileTab; drain enough microtasks to cover the chain.
    for (let i = 0; i < 10; i += 1) await tick();

    expect(ipcCommands.createFile).toHaveBeenCalledWith(VAULT, "Untitled.canvas");
    // Must seed with empty canvas JSON so Obsidian accepts the file.
    expect(ipcCommands.writeFile).toHaveBeenCalled();
    const [, seedContent] = (ipcCommands.writeFile as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(typeof seedContent).toBe("string");
    expect(JSON.parse(seedContent as string)).toEqual({ nodes: [], edges: [] });

    expect(openFileTabSpy).toHaveBeenCalledWith("/tmp/test-vault/Untitled.canvas", "canvas");

    // Menu closes after selection.
    expect(container.querySelector('[data-testid="sidebar-new-menu"]')).toBeNull();
  });

  it("keeps FolderPlus visible as its own button (ticket's lean-toward option)", async () => {
    const { container } = render(Sidebar, { props: makeProps() });
    await tick();
    const folderBtn = container.querySelector('button[aria-label="New folder"]');
    expect(folderBtn).toBeTruthy();
  });
});
