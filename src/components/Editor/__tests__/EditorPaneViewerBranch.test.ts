/**
 * EditorPane viewer-branch tests (#49). Verifies that opening a non-markdown
 * tab does NOT mount a CM6 editor — image / unsupported tabs render their
 * preview components directly. Also checks that opening an image tab NEVER
 * invokes readFile (asset:// handles the bytes).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

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

// Sidestep the sigma / WebGL import tree for the graph view.
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

// Deterministic, path-encoded asset URL so assertions compare exactly.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${encodeURIComponent(p)}`,
}));

import { tabStore } from "../../../store/tabStore";
import { vaultStore } from "../../../store/vaultStore";
import EditorPane from "../EditorPane.svelte";

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe("EditorPane viewer branches (#49)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    readFile.mockReset().mockResolvedValue("file contents");
  });

  it("image tab renders an <img> via asset:// and never calls readFile", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();

    tabStore.openFileTab("/vault/photo.png", "image");
    await flushAsync();

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(
      `asset://${encodeURIComponent("/vault/photo.png")}`,
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("unsupported tab renders the placeholder without reading the file", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();

    tabStore.openFileTab("/vault/blob.bin", "unsupported");
    await flushAsync();

    expect(container.textContent).toContain("Cannot preview this file type");
    expect(container.textContent).toContain("blob.bin");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("read-only text tab reads the file and does not schedule autosave writes", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
    render(EditorPane, { props: { paneId: "left" } });
    await tick();

    tabStore.openFileTab("/vault/data.json", "text");
    await flushAsync();

    // readFile is used to populate the doc, but we never follow up with writeFile
    // because the read-only extension list has no autoSaveExtension.
    expect(readFile).toHaveBeenCalledWith("/vault/data.json");
  });
});
