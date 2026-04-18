/**
 * Regression tests for issue #90: "Failed to open file" error shown despite
 * note opening successfully.
 *
 * Root cause: the mount-lifecycle $effect calls mountEditorView as
 * fire-and-forget async. Since viewMap is a plain Map (not reactive), the
 * effect cannot detect in-progress mounts. When allTabs changes while
 * readFile is in-flight, the effect re-fires and calls mountEditorView
 * again for the same tab — producing duplicate IPC calls and, when one
 * fails transiently, a spurious error toast while the note actually opens.
 *
 * The fix adds a mountingIds Set that prevents concurrent mount attempts
 * for the same tab ID.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock("../../../ipc/commands", () => ({
  readFile,
  writeFile: vi.fn().mockResolvedValue("0".repeat(64)),
  getFileHash: vi.fn().mockResolvedValue("0".repeat(64)),
  mergeExternalChange: vi.fn().mockResolvedValue({ outcome: "clean", merged_content: "" }),
  getResolvedLinks: vi.fn().mockResolvedValue(new Map()),
  getResolvedAttachments: vi.fn().mockResolvedValue(new Map()),
  createFile: vi.fn().mockResolvedValue(""),
  getLinkGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  getLocalGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  getBacklinks: vi.fn().mockResolvedValue([]),
  getOutgoingLinks: vi.fn().mockResolvedValue([]),
  getUnresolvedLinks: vi.fn().mockResolvedValue([]),
  listTags: vi.fn().mockResolvedValue([]),
  countWikiLinks: vi.fn().mockResolvedValue(0),
  suggestLinks: vi.fn().mockResolvedValue([]),
  searchFulltext: vi.fn().mockResolvedValue([]),
  searchFilename: vi.fn().mockResolvedValue([]),
  listDirectory: vi.fn().mockResolvedValue([]),
  invoke: vi.fn(),
  normalizeError: (e: unknown) => e,
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenVaultStatus: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeStart: vi.fn().mockResolvedValue(() => {}),
  listenBulkChangeEnd: vi.fn().mockResolvedValue(() => {}),
  listenIndexProgress: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../Graph/GraphView.svelte", async () => {
  // svelte-check's `*.svelte` module shim resolves static imports but not the
  // dynamic-import form inside vi.mock()'s hoisted factory — @ts-ignore the
  // phantom "no declaration" error.
  // @ts-ignore
  const { default: Empty } = await import("./emptyComponent.svelte");
  return { default: Empty };
});
vi.mock("../../Graph/graphRender", () => ({
  mountGraph: vi.fn(),
  updateGraph: vi.fn(),
  destroyGraph: vi.fn(),
  DEFAULT_FORCE_SETTINGS: {},
}));

import { tabStore } from "../../../store/tabStore";
import { vaultStore } from "../../../store/vaultStore";
import { toastStore } from "../../../store/toastStore";
import EditorPane from "../EditorPane.svelte";

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe("EditorPane mount race guard (#90)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    toastStore._reset();
    readFile.mockReset().mockResolvedValue("file contents");
  });

  it("does not call readFile twice when allTabs changes during mount", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });

    render(EditorPane, { props: { paneId: "left" } });
    await tick();

    // Make readFile slow so the $effect can re-fire while it's in-flight.
    let resolveRead!: (value: string) => void;
    readFile.mockImplementation(
      () => new Promise<string>((resolve) => { resolveRead = resolve; }),
    );

    // Open tab A — triggers the first mountEditorView call.
    tabStore.openTab("/vault/note-a.md");
    await tick();

    // Simulate a tab store mutation while readFile is in-flight (e.g.,
    // auto-save on another tab updates lastSavedHash). This re-triggers
    // the mount-lifecycle $effect.
    tabStore.setDirty(get(tabStore).tabs[0]!.id, true);
    await tick();

    // Resolve the pending readFile — mount completes.
    resolveRead("file contents");
    await flushAsync();

    // readFile should have been called exactly once — the in-flight guard
    // should have prevented the re-triggered $effect from scheduling a
    // duplicate mount.
    const reads = readFile.mock.calls.filter((c: string[]) => c[0] === "/vault/note-a.md");
    expect(reads.length).toBe(1);
  });

  it("shows no error toast when mount succeeds", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });

    render(EditorPane, { props: { paneId: "left" } });
    await tick();

    tabStore.openTab("/vault/clean.md");
    await flushAsync();

    const toasts = get(toastStore);
    const errorToasts = toasts.filter((t) => t.variant === "error");
    expect(errorToasts).toHaveLength(0);
  });

  it("includes the filename in the error toast when readFile fails", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });

    readFile.mockRejectedValue({ kind: "FileNotFound", message: "missing", data: null });

    render(EditorPane, { props: { paneId: "left" } });
    await tick();

    tabStore.openTab("/vault/missing-note.md");
    await flushAsync();

    const toasts = get(toastStore);
    const errorToasts = toasts.filter((t) => t.variant === "error");
    expect(errorToasts).toHaveLength(1);
    expect(errorToasts[0]!.message).toContain("missing-note.md");
  });

  it("allows retry after a transient readFile failure", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });

    // First call fails, second succeeds.
    readFile
      .mockRejectedValueOnce({ kind: "Io", message: "transient", data: null })
      .mockResolvedValue("recovered contents");

    render(EditorPane, { props: { paneId: "left" } });
    await tick();

    tabStore.openTab("/vault/flaky.md");
    await flushAsync();

    // First mount fails — mountingIds is cleaned up via finally, allowing retry.
    const toasts = get(toastStore);
    expect(toasts.some((t) => t.variant === "error")).toBe(true);

    // Trigger the $effect again (simulate any tab store mutation).
    tabStore.setDirty(get(tabStore).tabs[0]!.id, true);
    await flushAsync();

    // readFile should have been called twice: once failed, once succeeded.
    const reads = readFile.mock.calls.filter((c: string[]) => c[0] === "/vault/flaky.md");
    expect(reads.length).toBe(2);
  });

  it("does not produce an error toast for tab B when tab A fails", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });

    // Tab A will fail, tab B will succeed.
    readFile.mockImplementation((path: string) => {
      if (path === "/vault/broken.md") {
        return Promise.reject({ kind: "FileNotFound", message: "gone", data: null });
      }
      return Promise.resolve("good contents");
    });

    render(EditorPane, { props: { paneId: "left" } });
    await tick();

    // Open both tabs.
    tabStore.openTab("/vault/broken.md");
    tabStore.openTab("/vault/good.md");
    await flushAsync();

    const toasts = get(toastStore);
    const errorToasts = toasts.filter((t) => t.variant === "error");

    // All error toasts must name the broken file — never the good one.
    expect(errorToasts.length).toBeGreaterThanOrEqual(1);
    for (const t of errorToasts) {
      expect(t.message).toContain("broken.md");
      expect(t.message).not.toContain("good.md");
    }
  });
});
