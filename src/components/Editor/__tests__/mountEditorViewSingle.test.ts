/**
 * Regression guard for issue #41: "mountEditorView runs twice per tab click".
 *
 * The pre-fix code wrote to tabStore via setLastSavedContent BEFORE the
 * EditorView was registered in viewMap. That store mutation re-triggered
 * EditorPane's mount-lifecycle $effect while the first mount was still
 * awaiting the CM6 dynamic import, and the effect would schedule a second
 * mountEditorView for the same tab id — producing a redundant read_file IPC.
 *
 * The fix moves the setLastSavedContent call to AFTER viewMap.set(tab.id, view),
 * so the store mutation can no longer re-enter the mount-critical section.
 *
 * This test renders a real EditorPane, opens one tab, and asserts that
 * readFile was invoked exactly once for that tab's path.
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

// GraphView pulls in sigma → WebGL2RenderingContext at module init, which
// jsdom doesn't provide. We never render a graph tab in this test, so stub
// the component with an empty placeholder to keep the import tree light.
vi.mock("../../Graph/GraphView.svelte", async () => {
  const { default: Empty } = await import("./emptyComponent.svelte");
  return { default: Empty };
});

import { tabStore } from "../../../store/tabStore";
import { vaultStore } from "../../../store/vaultStore";
import EditorPane from "../EditorPane.svelte";

async function flushAsync(): Promise<void> {
  // Drain microtasks, macrotasks, and reactive ticks enough times to cover:
  // readFile promise, dynamic import("@codemirror/view"), post-import guards,
  // viewMap.set, the (post-fix) setLastSavedContent store emission, and the
  // subsequent $effect re-run that the fix ensures is a no-op.
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe("EditorPane mountEditorView (#41)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    readFile.mockReset().mockResolvedValue("file contents");
  });

  it("invokes readFile exactly once when opening a tab (no double-mount)", async () => {
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });

    render(EditorPane, { props: { paneId: "left" } });
    await tick();

    tabStore.openTab("/vault/note.md");

    await flushAsync();

    const reads = readFile.mock.calls.filter((c) => c[0] === "/vault/note.md");
    expect(reads.length).toBe(1);
  });
});
