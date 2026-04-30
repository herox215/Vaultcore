/**
 * #395 — EditorPane reacts to viewportStore.keyboardHeight transitions by
 * dispatching `EditorView.scrollIntoView(selection.main.head, { y: "center" })`
 * on the active markdown tab. Padding-bottom on `.vc-editor-container` (driven
 * by `--vc-keyboard-height`) shrinks CM6's host so the caret-relative
 * scrollIntoView lands above the keyboard.
 *
 * Dispatch rules:
 *   - Only on 0→>0 transition (keyboard opens) OR active-tab change while
 *     kb > 0 (so swiping to a different tab while typing recenters its caret).
 *     Per-pixel jitter does NOT re-dispatch.
 *   - Tab must support reading (markdown / undefined viewer).
 *   - Tab must be in edit mode.
 *   - This pane must be the active pane (`activePane === paneId`).
 *   - Active CM6 view must have DOM focus (`view.hasFocus`).
 *
 * Test setup mirrors `EditorPane.wikiLinkMobileMode.test.ts` for the IPC /
 * Graph mock chain. `viewportStore` is mocked via a hoisted writable so each
 * test can flip `keyboardHeight` deterministically without `vi.resetModules`
 * (which is incompatible with Svelte 5 effect tracking — see the
 * TopbarReadingToggle.test.ts header in #388 for the full story).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";

const { viewportWritable } = vi.hoisted(() => ({
  viewportWritable: (() => {
    const { writable } = require("svelte/store");
    return writable({ mode: "mobile", isCoarsePointer: true, keyboardHeight: 0 });
  })(),
}));

vi.mock("../../../store/viewportStore", () => ({
  viewportStore: viewportWritable,
  createViewportStore: () => viewportWritable,
}));

const { readFile, getResolvedLinks, getResolvedAnchors, getResolvedAttachments } = vi.hoisted(() => ({
  readFile: vi.fn().mockResolvedValue(""),
  getResolvedLinks: vi.fn().mockResolvedValue(new Map()),
  getResolvedAnchors: vi.fn().mockResolvedValue(new Map()),
  getResolvedAttachments: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../../ipc/commands", () => ({
  readFile,
  createFile: vi.fn().mockResolvedValue(""),
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

import { tabStore } from "../../../store/tabStore";
import { vaultStore } from "../../../store/vaultStore";
import EditorPane from "../EditorPane.svelte";

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await tick();
  }
}

function setKeyboardHeight(kb: number): void {
  viewportWritable.set({ mode: "mobile", isCoarsePointer: true, keyboardHeight: kb });
}

function setViewportMode(mode: "desktop" | "tablet" | "mobile", kb: number = 0): void {
  viewportWritable.set({
    mode,
    isCoarsePointer: mode === "mobile",
    keyboardHeight: kb,
  });
}

/**
 * Stub `requestAnimationFrame` to run callbacks synchronously so the
 * scrollIntoView dispatch happens within `flushAsync`'s reach without timing
 * uncertainty. Restored in afterEach via `vi.restoreAllMocks`.
 */
function stubRaf(): void {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
}

interface MountedPane {
  container: HTMLElement;
  cm: HTMLElement;
  tabId: string;
}

async function mountPaneWithMarkdownTab(paneId: "left" | "right" = "left"): Promise<MountedPane> {
  const { container } = render(EditorPane, { props: { paneId } });
  await flushAsync();
  const tabId = tabStore.openTab("/vault/host.md", "edit");
  await flushAsync();
  const cm = container.querySelector(".cm-editor") as HTMLElement | null;
  if (!cm) throw new Error("CM6 editor did not mount");
  return { container, cm, tabId };
}

/**
 * The CM6 view is held in EditorPane's module-private `viewMap` (Svelte 5
 * doesn't expose component internals). Recover it through the DOM: CM6
 * stores a back-reference at `.cmView` on its `.cm-editor` element under
 * the `view` field of the EditorView instance. We rely on
 * `EditorView.findFromDOM(cm)` instead — the official API.
 */
async function getActiveView(cm: HTMLElement): Promise<{ dispatch: ReturnType<typeof vi.spyOn> }> {
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(cm);
  if (!view) throw new Error("Could not recover EditorView from DOM");
  // Force focus so the `view.hasFocus` gate passes for the dispatch tests.
  view.focus();
  // jsdom's focus() may not flip `view.hasFocus` (which reads
  // `document.activeElement === this.contentDOM`). Override via spy.
  Object.defineProperty(view, "hasFocus", { configurable: true, get: () => true });
  return { dispatch: vi.spyOn(view, "dispatch") };
}

describe("EditorPane keyboard-aware scroll (#395)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    setViewportMode("mobile", 0);
    stubRaf();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: ["host.md", "other.md"],
      fileCount: 2,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("dispatches scrollIntoView once when keyboard opens (0 → 250) on focused edit-mode markdown", async () => {
    const { cm } = await mountPaneWithMarkdownTab();
    const { dispatch } = await getActiveView(cm);

    setKeyboardHeight(250);
    await flushAsync();

    const calls = dispatch.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(calls.length).toBe(1);
  });

  it("does NOT re-dispatch on per-pixel jitter (250 → 245 → 260)", async () => {
    const { cm } = await mountPaneWithMarkdownTab();
    const { dispatch } = await getActiveView(cm);

    setKeyboardHeight(250);
    await flushAsync();
    setKeyboardHeight(245);
    await flushAsync();
    setKeyboardHeight(260);
    await flushAsync();

    const calls = dispatch.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(calls.length).toBe(1);
  });

  it("dispatches twice when keyboard reopens (0 → 250 → 0 → 250)", async () => {
    const { cm } = await mountPaneWithMarkdownTab();
    const { dispatch } = await getActiveView(cm);

    setKeyboardHeight(250);
    await flushAsync();
    setKeyboardHeight(0);
    await flushAsync();
    setKeyboardHeight(250);
    await flushAsync();

    const calls = dispatch.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(calls.length).toBe(2);
  });

  it("dispatches an additional scrollIntoView when active tab changes while keyboard is open", async () => {
    const { cm } = await mountPaneWithMarkdownTab();
    const { dispatch: dispatchA } = await getActiveView(cm);

    setKeyboardHeight(250);
    await flushAsync();
    expect(dispatchA.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object)).length).toBe(1);

    // Pre-spy on the second tab's CM6 view BEFORE making it active. We do
    // this by opening the tab first (which mounts its view but leaves it
    // inactive briefly — the new tab DOES become active immediately, so
    // the dispatch may fire synchronously inside the activation effect).
    // Strategy: open tab, immediately spy on the just-mounted view, THEN
    // flush so any effect-driven dispatches are observable on dispatchB.
    tabStore.openTab("/vault/other.md", "edit");
    // Settle one microtask so the new container exists and CM6 mounts.
    await flushAsync();

    const cms = document.querySelectorAll(".cm-editor");
    expect(cms.length).toBeGreaterThanOrEqual(2);
    const activeCm = cms[cms.length - 1] as HTMLElement;
    const { EditorView: EV } = await import("@codemirror/view");
    const viewB = EV.findFromDOM(activeCm);
    if (!viewB) throw new Error("no view B");
    Object.defineProperty(viewB, "hasFocus", { configurable: true, get: () => true });
    const dispatchB = vi.spyOn(viewB, "dispatch");

    // Re-emit kb to force the $effect to re-run against the new active
    // tab id — `lastDispatchTabId !== tabId` should fire dispatchB now.
    // Per-pixel value is irrelevant; pick a different number to exercise
    // the change path.
    setKeyboardHeight(260);
    await flushAsync();

    const dispatchBCalls = dispatchB.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(dispatchBCalls.length).toBe(1);
  });

  it("does NOT dispatch when active tab is in read mode", async () => {
    const { cm } = await mountPaneWithMarkdownTab();
    const { dispatch } = await getActiveView(cm);

    // Flip the existing tab to read mode (use the already-opened host.md).
    const active = tabStore.getActiveTab();
    if (active) tabStore.setViewMode(active.id, "read");
    await flushAsync();

    setKeyboardHeight(250);
    await flushAsync();

    const calls = dispatch.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(calls.length).toBe(0);
  });

  it("does NOT dispatch when the CM6 view does not have focus", async () => {
    const { cm } = await mountPaneWithMarkdownTab();
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(cm);
    if (!view) throw new Error("no view");
    // Override hasFocus to false; do NOT focus().
    Object.defineProperty(view, "hasFocus", { configurable: true, get: () => false });
    const dispatch = vi.spyOn(view, "dispatch");

    setKeyboardHeight(250);
    await flushAsync();

    const calls = dispatch.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(calls.length).toBe(0);
  });

  it("does NOT dispatch on a non-active pane (left pane stays quiet when right pane is active)", async () => {
    // Setup:
    //   1. Open tab A (host.md) in left pane.
    //   2. Mount the right pane.
    //   3. Open tab B (other.md) — lands in the active pane (left), then we
    //      move it to the right pane via `moveToPane("right")`, which flips
    //      `activePane` to "right".
    //   4. With kb=0 still, attach the left-pane spy AFTER the move so any
    //      mount-time dispatches don't pollute the count.
    //   5. Emit kb=250 → only the RIGHT pane (active) should dispatch.
    //      Left pane's spy stays at 0.
    const { cm: leftCm } = await mountPaneWithMarkdownTab("left");
    render(EditorPane, { props: { paneId: "right" } });
    await flushAsync();

    tabStore.openTab("/vault/other.md", "edit");
    await flushAsync();
    tabStore.moveToPane("right");
    await flushAsync();

    // The left pane still holds tab A (host.md). Spy on its CM6 view AFTER
    // the moveToPane so we don't count any pre-move dispatches.
    const { EditorView: EV } = await import("@codemirror/view");
    const leftView = EV.findFromDOM(leftCm);
    if (!leftView) throw new Error("no left view");
    Object.defineProperty(leftView, "hasFocus", { configurable: true, get: () => true });
    const leftDispatch = vi.spyOn(leftView, "dispatch");

    setKeyboardHeight(250);
    await flushAsync();

    const leftCalls = leftDispatch.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(leftCalls.length).toBe(0);
  });

  it("rapid tab switch between rAF schedule and frame: tab-A's stale dispatch is suppressed", async () => {
    // Aristotle iter-1 #1 regression guard. Sequence:
    //   1. Tab A active, kb opens → $effect schedules rAF for A.
    //   2. User switches to tab B BEFORE the frame fires.
    //   3. The pending rAF callback re-checks the live tab id; since the
    //      active tab is now B, it skips the dispatch (no stale-view crash,
    //      no scroll on a tab the user moved away from).
    //   4. The new $effect for tab B independently schedules its own rAF
    //      and dispatches normally.
    //
    // Override the synchronous stubRaf with a queuing rAF so we can hold
    // the callback while we mutate state in the test.
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const { cm: cmA } = await mountPaneWithMarkdownTab();
    const { EditorView: EV } = await import("@codemirror/view");
    const viewA = EV.findFromDOM(cmA);
    if (!viewA) throw new Error("no view A");
    Object.defineProperty(viewA, "hasFocus", { configurable: true, get: () => true });
    const dispatchA = vi.spyOn(viewA, "dispatch");

    setKeyboardHeight(250);
    await flushAsync();
    // At least one rAF queued for tab A. Not flushed yet.
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(dispatchA.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object)).length).toBe(0);

    // User switches to tab B mid-flight (BEFORE any frame fires for A).
    tabStore.openTab("/vault/other.md", "edit");
    await flushAsync();

    // Flush ALL queued rAFs. Each one captured `scheduledTabId` at the
    // moment it was enqueued; the rAFs scheduled while tab A was active
    // must skip their dispatch because the live active tab is now B.
    while (queue.length > 0) {
      const cb = queue.shift()!;
      cb(0);
    }

    // Property under test: no dispatch lands on viewA (the stale view
    // belonging to tab A — which is still active in this single-pane setup
    // since openTab dedupes/activates new tabs in the same pane). With the
    // pre-rAF guard removed, the rAF re-checks the active tab id at frame
    // time and skips when it doesn't match the captured tab id.
    const dispatchACalls = dispatchA.mock.calls.filter((c: unknown[]) => "effects" in (c[0] as object));
    expect(dispatchACalls.length).toBe(0);
  });
});
