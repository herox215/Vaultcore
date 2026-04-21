/**
 * #309 — `EditorPane.handleWikiLinkClick()` must synchronously re-check the
 * resolved-links map before routing into the create-at-root fallback. The
 * CM6 template live-preview widget bakes `data-wiki-resolved` into the DOM
 * at decoration-build time; between that moment and the click, a file
 * create / rename / move can make the once-unresolved target resolvable. If
 * the click handler trusted the stale attribute, it would spawn a duplicate
 * note at the vault root instead of opening the real file.
 *
 * This test dispatches a `wiki-link-click` CustomEvent with
 * `detail.resolved = false` but seeds the resolved-links map with a live
 * entry. Expected behaviour: `tabStore.openTab` fires on the resolved path;
 * `createFile` is not called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";

const { readFile, createFile, getResolvedLinks, getResolvedAttachments } = vi.hoisted(() => ({
  readFile: vi.fn().mockResolvedValue(""),
  createFile: vi.fn().mockResolvedValue(""),
  getResolvedLinks: vi.fn().mockResolvedValue(new Map()),
  getResolvedAttachments: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../../ipc/commands", () => ({
  readFile,
  createFile,
  writeFile: vi.fn().mockResolvedValue("0".repeat(64)),
  getFileHash: vi.fn().mockResolvedValue("0".repeat(64)),
  mergeExternalChange: vi.fn().mockResolvedValue({ outcome: "clean", merged_content: "" }),
  getResolvedLinks,
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

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${encodeURIComponent(p)}`,
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

describe("EditorPane wiki-link click — live-lookup against stale decoration (#309)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    createFile.mockReset().mockResolvedValue("");
    getResolvedLinks.mockReset().mockResolvedValue(new Map());
    getResolvedAttachments.mockReset().mockResolvedValue(new Map());
    setResolvedLinks(new Map());
  });

  afterEach(() => {
    // svelte-testing-library doesn't auto-unmount on the version pinned here,
    // so subscriptions (vault / resolvedLinks / tabStore) from one test stay
    // live during the next and can replay async callbacks in an unrelated
    // test's timeline. `cleanup()` tears down every render() + spy set up by
    // the test.
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * `wiki-link-click` is dispatched on the CM6 view's own DOM node, not the
   * pane root. Mount a markdown tab so EditorPane wires up a CM6 EditorView,
   * then grab its `.cm-editor` root to fire the event from there.
   */
  async function mountMarkdownTabAndGetCm(): Promise<HTMLElement> {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await flushAsync();
    tabStore.openFileTab("/vault/host.md", "markdown");
    await flushAsync();
    const cm = container.querySelector(".cm-editor") as HTMLElement | null;
    if (!cm) throw new Error("CM6 editor did not mount");
    return cm;
  }

  it("opens the file via the resolved branch even when detail.resolved is stale-false", async () => {
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md", "test/Untitled.md"],
      fileCount: 2,
    });
    const cm = await mountMarkdownTabAndGetCm();

    // Stage the live map: `Untitled` is now resolvable to `test/Untitled.md`.
    setResolvedLinks(new Map([["untitled", "test/Untitled.md"]]));

    const openTabSpy = vi.spyOn(tabStore, "openTab");

    cm.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: "Untitled", resolved: false },
      }),
    );
    await flushAsync();

    expect(createFile).not.toHaveBeenCalled();
    expect(openTabSpy).toHaveBeenCalledWith("/vault/test/Untitled.md");
  });

  it("triggers a reload without opening or creating when the live map lost the target (resolved=true, liveRelPath=null)", async () => {
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md"],
      fileCount: 1,
    });
    const cm = await mountMarkdownTabAndGetCm();

    // Baseline: `getResolvedLinks` was called once at vault-open. Clear so we
    // can isolate the reload the click handler triggers.
    getResolvedLinks.mockClear();

    // Stale decoration says resolved=true but the live map has no entry —
    // matches the "file deleted between decoration and click" scenario.
    setResolvedLinks(new Map());

    const openTabSpy = vi.spyOn(tabStore, "openTab");
    const openFileTabSpy = vi.spyOn(tabStore, "openFileTab");

    cm.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: "DeletedNote", resolved: true },
      }),
    );
    await flushAsync();

    // Neither open nor create: the click short-circuits into a reload so
    // the next render's decoration reflects the true state.
    expect(openTabSpy).not.toHaveBeenCalled();
    expect(openFileTabSpy).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
    expect(getResolvedLinks).toHaveBeenCalled();
  });

  it("still falls back to create-at-root when the live map also lacks the target", async () => {
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md"],
      fileCount: 1,
    });
    const cm = await mountMarkdownTabAndGetCm();

    createFile.mockResolvedValueOnce("/vault/Ghost.md");

    cm.dispatchEvent(
      new CustomEvent("wiki-link-click", {
        bubbles: true,
        detail: { target: "Ghost", resolved: false },
      }),
    );
    await flushAsync();

    expect(createFile).toHaveBeenCalledWith("/vault", "Ghost.md");
  });
});
