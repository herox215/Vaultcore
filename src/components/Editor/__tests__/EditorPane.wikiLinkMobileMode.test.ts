/**
 * #388 — wiki-link click in EditorPane respects the mobile read-mode default.
 *
 * Two paths to cover:
 *   1. Resolved follow: `[[target]]` resolves to an existing note → click
 *      opens the target via `tabStore.openTab(absPath, "read")` on mobile,
 *      `(absPath, "edit")` on desktop.
 *   2. Click-to-create: `[[Ghost]]` does not resolve → click creates the new
 *      note via `createFile` and opens it with viewMode === "edit"
 *      regardless of viewport (rule: NEW notes default to edit).
 *
 * The dispatcher helper `defaultViewModeForViewport` reads `viewportStore`
 * once per call. Each test installs a mocked `viewportStore` via
 * `vi.doMock` + `vi.resetModules` before importing `EditorPane`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import { readable } from "svelte/store";

const { readFile, createFile, getResolvedLinks, getResolvedAnchors, getResolvedAttachments } = vi.hoisted(() => ({
  readFile: vi.fn().mockResolvedValue(""),
  createFile: vi.fn().mockResolvedValue(""),
  getResolvedLinks: vi.fn().mockResolvedValue(new Map()),
  getResolvedAnchors: vi.fn().mockResolvedValue(new Map()),
  getResolvedAttachments: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../../ipc/commands", () => ({
  readFile,
  createFile,
  writeFile: vi.fn().mockResolvedValue("0".repeat(64)),
  getFileHash: vi.fn().mockResolvedValue("0".repeat(64)),
  mergeExternalChange: vi.fn().mockResolvedValue({ outcome: "clean", merged_content: "" }),
  getResolvedLinks,
  getResolvedAnchors,
  getResolvedAttachments,
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
  // @ts-ignore — *.svelte shim doesn't expose default in dynamic-import form
  const { default: Empty } = await import("./emptyComponent.svelte");
  return { default: Empty };
});
vi.mock("../../Graph/graphRender", () => ({
  mountGraph: vi.fn(),
  updateGraph: vi.fn(),
  destroyGraph: vi.fn(),
  DEFAULT_FORCE_SETTINGS: {},
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${encodeURIComponent(p)}`,
}));

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await tick();
  }
}

/**
 * Mock viewportStore at the module level for the duration of the test, then
 * import EditorPane fresh so the wiki-link handler's `defaultViewModeForViewport`
 * call resolves to the mocked store. `vi.resetModules` is required so the
 * dispatcher is re-evaluated against the fresh mock instead of a cached graph.
 */
async function setupWithViewport(
  mode: "desktop" | "mobile",
): Promise<{
  EditorPane: any;
  tabStore: typeof import("../../../store/tabStore").tabStore;
  vaultStore: typeof import("../../../store/vaultStore").vaultStore;
  setResolvedLinks: typeof import("../wikiLink").setResolvedLinks;
}> {
  vi.resetModules();
  vi.doMock("../../../store/viewportStore", () => ({
    viewportStore: readable({ mode, isCoarsePointer: mode === "mobile" }),
  }));
  // Re-mock the IPC layer so the freshly-imported EditorPane shares the spies.
  vi.doMock("../../../ipc/commands", () => ({
    readFile,
    createFile,
    writeFile: vi.fn().mockResolvedValue("0".repeat(64)),
    getFileHash: vi.fn().mockResolvedValue("0".repeat(64)),
    mergeExternalChange: vi.fn().mockResolvedValue({ outcome: "clean", merged_content: "" }),
    getResolvedLinks,
    getResolvedAnchors,
    getResolvedAttachments,
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

  const { tabStore } = await import("../../../store/tabStore");
  const { vaultStore } = await import("../../../store/vaultStore");
  const { setResolvedLinks } = await import("../wikiLink");
  const EditorPane = (await import("../EditorPane.svelte")).default;
  return { EditorPane, tabStore, vaultStore, setResolvedLinks };
}

async function mountMarkdownTabAndGetCm(
  EditorPane: any,
  tabStore: { openFileTab: (p: string, v: string) => string },
): Promise<HTMLElement> {
  const { container } = render(EditorPane, { props: { paneId: "left" } });
  await flushAsync();
  tabStore.openFileTab("/vault/host.md", "markdown");
  await flushAsync();
  const cm = container.querySelector(".cm-editor") as HTMLElement | null;
  if (!cm) throw new Error("CM6 editor did not mount");
  return cm;
}

describe("EditorPane wiki-link click — mobile read-mode default (#388)", () => {
  beforeEach(() => {
    createFile.mockReset().mockResolvedValue("");
    getResolvedLinks.mockReset().mockResolvedValue(new Map());
    getResolvedAnchors.mockReset().mockResolvedValue(new Map());
    getResolvedAttachments.mockReset().mockResolvedValue(new Map());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.doUnmock("../../../store/viewportStore");
  });

  it("on mobile, resolved wiki-link follow opens target with viewMode='read'", async () => {
    const { EditorPane, tabStore, vaultStore, setResolvedLinks } = await setupWithViewport("mobile");
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md", "target.md"],
      fileCount: 2,
    });
    const cm = await mountMarkdownTabAndGetCm(EditorPane, tabStore);
    setResolvedLinks(new Map([["target", "target.md"]]));

    const openTabSpy = vi.spyOn(tabStore, "openTab");

    cm.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: "target", resolution: "resolved", anchor: null },
      }),
    );
    await flushAsync();

    expect(openTabSpy).toHaveBeenCalledWith("/vault/target.md", "read");
  });

  it("on desktop, resolved wiki-link follow opens target with viewMode='edit'", async () => {
    const { EditorPane, tabStore, vaultStore, setResolvedLinks } = await setupWithViewport("desktop");
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md", "target.md"],
      fileCount: 2,
    });
    const cm = await mountMarkdownTabAndGetCm(EditorPane, tabStore);
    setResolvedLinks(new Map([["target", "target.md"]]));

    const openTabSpy = vi.spyOn(tabStore, "openTab");

    cm.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: "target", resolution: "resolved", anchor: null },
      }),
    );
    await flushAsync();

    expect(openTabSpy).toHaveBeenCalledWith("/vault/target.md", "edit");
  });

  it("on mobile, click-to-create new note opens with viewMode='edit' (NEW notes default to edit)", async () => {
    // Rule: NEW notes default to edit on every viewport. EXISTING notes
    // default to read on mobile. This matches createNewNote / openTodayNote /
    // Sidebar new-file convention — the user clicking an unresolved [[Foo]]
    // is creating a note and presumably wants to write into it.
    const { EditorPane, tabStore, vaultStore } = await setupWithViewport("mobile");
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md"],
      fileCount: 1,
    });
    const cm = await mountMarkdownTabAndGetCm(EditorPane, tabStore);
    createFile.mockResolvedValueOnce("/vault/Ghost.md");

    const openTabSpy = vi.spyOn(tabStore, "openTab");

    cm.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: "Ghost", resolution: "unresolved", anchor: null },
      }),
    );
    await flushAsync();

    expect(createFile).toHaveBeenCalledWith("/vault", "Ghost.md");
    expect(openTabSpy).toHaveBeenCalledWith("/vault/Ghost.md", "edit");
  });

  it("on desktop, click-to-create new note opens with viewMode='edit'", async () => {
    const { EditorPane, tabStore, vaultStore } = await setupWithViewport("desktop");
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md"],
      fileCount: 1,
    });
    const cm = await mountMarkdownTabAndGetCm(EditorPane, tabStore);
    createFile.mockResolvedValueOnce("/vault/Ghost.md");

    const openTabSpy = vi.spyOn(tabStore, "openTab");

    cm.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: "Ghost", resolution: "unresolved", anchor: null },
      }),
    );
    await flushAsync();

    expect(openTabSpy).toHaveBeenCalledWith("/vault/Ghost.md", "edit");
  });
});
