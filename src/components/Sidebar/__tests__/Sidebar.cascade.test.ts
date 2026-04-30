// Regression test for issue #378: the rename-cascade dialog must survive the
// watcher-driven tree re-flatten. Before the fix, `pendingRename` lived on
// TreeRow; the keyed `{#each}` block destroyed the renamed row before its
// post-IPC closure could mutate state, so the dialog never painted. After the
// fix, ownership lives on Sidebar — the single component that survives the
// re-flatten by definition.

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
  getBacklinks: vi.fn(),
  loadBookmarks: vi.fn(),
  saveBookmarks: vi.fn(),
  writeFile: vi.fn(),
  listTags: vi.fn(),
  renameFile: vi.fn(),
  exportDecryptedFile: vi.fn(),
  pickSavePath: vi.fn(),
  lockFolder: vi.fn(),
  listEncryptedFolders: vi.fn(),
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockImplementation((cb: (p: any) => void) => {
    capturedFileChangeHandler = cb;
    return Promise.resolve(() => {});
  }),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
  listenIndexProgress: vi.fn().mockResolvedValue(() => {}),
  listenVaultStatus: vi.fn().mockResolvedValue(() => {}),
  listenEncryptProgress: vi.fn().mockResolvedValue(() => {}),
  listenEncryptedFoldersChanged: vi.fn().mockResolvedValue(() => {}),
  listenEncryptDropProgress: vi.fn().mockResolvedValue(() => {}),
}));

import {
  listDirectory,
  renameFile,
  getBacklinks,
  updateLinksAfterRename,
  loadBookmarks,
  saveBookmarks,
  listTags,
  listEncryptedFolders,
} from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import Sidebar from "../Sidebar.svelte";
import type { DirEntry } from "../../../types/tree";

let capturedFileChangeHandler: ((p: any) => void) | null = null;

const VAULT = "/tmp/test-vault";

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

function md(name: string): DirEntry {
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

async function drainMicrotasks() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

describe("Sidebar rename cascade survives tree re-flatten (#378)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    capturedFileChangeHandler = null;
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
    vi.clearAllMocks();
    // Re-seed every mock return value AFTER clearAllMocks. Setting them in
    // the vi.mock() factory only would be wiped by clearAllMocks and the
    // confirm path below would receive `undefined` from updateLinksAfterRename.
    (renameFile as any).mockResolvedValue({
      newPath: `${VAULT}/Welcome Renamed.md`,
      linkCount: 3,
    });
    (updateLinksAfterRename as any).mockResolvedValue({
      updatedFiles: 2,
      updatedLinks: 3,
      failedFiles: [],
      updatedPaths: [],
    });
    (loadBookmarks as any).mockResolvedValue([]);
    (saveBookmarks as any).mockResolvedValue(undefined);
    (listTags as any).mockResolvedValue([]);
    (listEncryptedFolders as any).mockResolvedValue([]);
    (getBacklinks as any).mockResolvedValue([
      { sourcePath: "Daily Log.md" },
      { sourcePath: "Ideas.md" },
      { sourcePath: "Wiki Links.md" },
    ]);
  });

  it("opens the cascade dialog on rename and keeps it mounted across a watcher re-flatten", async () => {
    (listDirectory as any).mockResolvedValueOnce([md("Welcome.md")]);

    const { container } = render(Sidebar, { props: makeProps() });
    await drainMicrotasks();

    // Open the row's context menu, click Rename, type a new name, press Enter.
    const row = container.querySelector(".vc-tree-row") as HTMLElement;
    expect(row).toBeTruthy();
    await fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    await tick();

    const renameItem = Array.from(
      container.querySelectorAll(".vc-context-item"),
    ).find((el) => (el.textContent ?? "").trim() === "Rename") as HTMLElement;
    expect(renameItem).toBeTruthy();
    renameItem.click();
    await tick();

    const input = container.querySelector(".vc-rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "Welcome Renamed.md";
    await fireEvent.input(input);
    await fireEvent.keyDown(input, { key: "Enter" });

    // Drain so the IPC mock resolves and `pendingRename` is set on whichever
    // component owns it, BEFORE the watcher event lands. This isolates the
    // race: the dialog must exist after a re-flatten, regardless of whether
    // it was already painted at the moment of the watcher event.
    await drainMicrotasks();

    // Pre-flatten sanity: the dialog should already be in the DOM (otherwise
    // we are not testing the lift, we are testing whether rename-with-links
    // works at all).
    const preFlattenDialog = container.querySelector('[role="dialog"][aria-labelledby^="rename-heading"]');
    expect(preFlattenDialog).toBeTruthy();

    // Now simulate the watcher event: listDirectory now returns the renamed
    // row, the {#each} re-keys, and the original TreeRow under the old path
    // unmounts. Before the #378 fix, this destroyed the pendingRename state.
    (listDirectory as any).mockResolvedValueOnce([md("Welcome Renamed.md")]);
    expect(capturedFileChangeHandler).toBeTruthy();
    capturedFileChangeHandler!({
      path: `${VAULT}/Welcome.md`,
      kind: "rename",
      new_path: `${VAULT}/Welcome Renamed.md`,
    });

    await drainMicrotasks();

    // The cascade dialog must be in the DOM.
    const dialog = container.querySelector('[role="dialog"][aria-labelledby^="rename-heading"]');
    expect(dialog).toBeTruthy();

    const body = container.querySelector(".vc-confirm-body") as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.textContent ?? "").toMatch(/3\s+Links?\s+in\s+\d+\s+Dateien/);

    // Sanity: the row that owned the original `pendingRename` is no longer
    // mounted under the old path — the {#each} re-keyed it. Without the fix,
    // this is exactly the moment the dialog would disappear.
    const oldRow = container.querySelector(`[data-tree-row="${VAULT}/Welcome.md"]`);
    expect(oldRow).toBeNull();
    const newRow = container.querySelector(`[data-tree-row="${VAULT}/Welcome Renamed.md"]`);
    expect(newRow).toBeTruthy();
  });
});
