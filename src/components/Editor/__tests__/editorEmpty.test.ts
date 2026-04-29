// Issue #358 PR C — editor empty state replaces the prose copy with an
// ASCII vault-door diagram (decorative, aria-hidden) plus a symbol-key
// legend (meaningful, NOT aria-hidden) and a visually-hidden <h2>
// summary so screen readers continue to announce "No file open" with
// the platform-aware open-file shortcut.
//
// Heavy IPC and graph deps are mocked so EditorPane mounts cleanly in
// jsdom — only the empty-state branch is exercised.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  readFile: vi.fn().mockResolvedValue(""),
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
import EditorPane from "../EditorPane.svelte";

describe("EditorPane empty state — ASCII vault door + legend (#358)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("renders the vault-door <pre> with aria-hidden=true", async () => {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const door = container.querySelector("pre.vc-editor-empty-door");
    expect(door).toBeTruthy();
    expect(door!.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders a legend block that is NOT aria-hidden (it's meaningful)", async () => {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const legend = container.querySelector(".vc-editor-empty-legend");
    expect(legend).toBeTruthy();
    expect(legend!.getAttribute("aria-hidden")).not.toBe("true");
    const text = legend!.textContent ?? "";
    expect(text).toContain("[ ]");
    expect(text).toContain("░");
    expect(text).toContain("▒");
  });

  it("renders a visually-hidden <h2> summary mentioning 'No file open'", async () => {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const h2 = container.querySelector("h2.vc-sr-only");
    expect(h2).toBeTruthy();
    expect(h2!.textContent).toMatch(/No file open/i);
  });

  it("does not render the legacy 'Select a file from the sidebar to get started.' copy", async () => {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Select a file from the sidebar to get started/);
  });

  it("the legend mentions the open-file shortcut (⌘ on macOS or Ctrl elsewhere)", async () => {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    const legend = container.querySelector(".vc-editor-empty-legend")!;
    const text = legend.textContent ?? "";
    expect(text).toMatch(/[⌘]|Ctrl/);
    expect(text).toMatch(/O/);
  });
});
