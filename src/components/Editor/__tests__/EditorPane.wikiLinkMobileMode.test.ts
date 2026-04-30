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
 * Strategy: mock `defaultViewModeForViewport` directly (instead of
 * `viewportStore`), then flip its return value per-test via the spy. This
 * sidesteps `vi.resetModules` interactions with `lucide-svelte`'s module
 * graph that caused `from_svg is not a function` runtime errors when the
 * EditorPane subtree was re-imported under a swapped viewport mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";

const {
  readFile,
  createFile,
  getResolvedLinks,
  getResolvedAnchors,
  getResolvedAttachments,
  defaultViewModeForViewport,
} = vi.hoisted(() => ({
  readFile: vi.fn().mockResolvedValue(""),
  createFile: vi.fn().mockResolvedValue(""),
  getResolvedLinks: vi.fn().mockResolvedValue(new Map()),
  getResolvedAnchors: vi.fn().mockResolvedValue(new Map()),
  getResolvedAttachments: vi.fn().mockResolvedValue(new Map()),
  defaultViewModeForViewport: vi.fn(() => "edit" as "edit" | "read"),
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

// #388 — mock `defaultViewModeForViewport` so each test can flip the return
// value at call time. EditorPane imports this from `../../lib/viewport`
// (extracted out of `tabKind.ts` to keep the classifier module pure /
// store-free).
vi.mock("../../../lib/viewport", () => ({
  defaultViewModeForViewport,
}));

import { tabStore } from "../../../store/tabStore";
import { vaultStore } from "../../../store/vaultStore";
import { setResolvedLinks } from "../wikiLink";
import EditorPane from "../EditorPane.svelte";

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await tick();
  }
}

async function mountMarkdownTabAndGetCm(): Promise<HTMLElement> {
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
    tabStore._reset();
    vaultStore.reset();
    createFile.mockReset().mockResolvedValue("");
    getResolvedLinks.mockReset().mockResolvedValue(new Map());
    getResolvedAnchors.mockReset().mockResolvedValue(new Map());
    getResolvedAttachments.mockReset().mockResolvedValue(new Map());
    defaultViewModeForViewport.mockReset().mockReturnValue("edit");
    setResolvedLinks(new Map());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("on mobile, resolved wiki-link follow opens target with viewMode='read'", async () => {
    defaultViewModeForViewport.mockReturnValue("read");
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md", "target.md"],
      fileCount: 2,
    });
    const cm = await mountMarkdownTabAndGetCm();
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
    defaultViewModeForViewport.mockReturnValue("edit");
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md", "target.md"],
      fileCount: 2,
    });
    const cm = await mountMarkdownTabAndGetCm();
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
    defaultViewModeForViewport.mockReturnValue("read");
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md"],
      fileCount: 1,
    });
    const cm = await mountMarkdownTabAndGetCm();
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
    defaultViewModeForViewport.mockReturnValue("edit");
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md"],
      fileCount: 1,
    });
    const cm = await mountMarkdownTabAndGetCm();
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
