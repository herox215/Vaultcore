// EditorPane long-press → context menu (#387). Touch parity for the existing
// right-click context-menu path (#301), implemented by wiring `use:longPress`
// on `.vc-editor-content`. The synthetic contextmenu that some platforms
// dispatch after a touch hold must NOT also bubble through CM6's
// `editorContextMenuExtension`, which would surface the menu twice.
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
import EditorPane from "../EditorPane.svelte";

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await tick();
  }
}

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerType?: string } = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "touch", configurable: true });
  return ev;
}

describe("EditorPane long-press → context menu (#387)", () => {
  beforeEach(() => {
    tabStore._reset();
    vaultStore.reset();
    readFile.mockReset().mockResolvedValue("hello world");
    vaultStore.setReady({ currentPath: "/vault", fileList: ["note.md"], fileCount: 1 });
  });

  it("opens the custom context menu after a 500ms touch hold on .vc-editor-content", async () => {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    tabStore.openTab("/vault/note.md");
    await flushAsync();

    const surface = container.querySelector(".vc-editor-content") as HTMLElement;
    expect(surface).toBeTruthy();
    expect(container.querySelector(".vc-context-menu")).toBeNull();

    surface.dispatchEvent(pointerEvent("pointerdown", { clientX: 120, clientY: 80 }));
    // Real timers — the action's setTimeout(500) drives this. 600ms gives a
    // safe margin without making the test sluggish.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await tick();

    const menu = container.querySelector(".vc-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.top).toBe("80px");
    expect(menu.style.left).toBe("120px");
  });

  it("the synthetic contextmenu after a long-press fire is suppressed (no double-open via CM6)", async () => {
    const { container } = render(EditorPane, { props: { paneId: "left" } });
    await tick();
    tabStore.openTab("/vault/note.md");
    await flushAsync();

    const surface = container.querySelector(".vc-editor-content") as HTMLElement;
    surface.dispatchEvent(pointerEvent("pointerdown", { clientX: 50, clientY: 50 }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    await tick();

    const menusAfterFire = container.querySelectorAll(".vc-context-menu");
    expect(menusAfterFire.length).toBe(1);

    // A bubble-phase contextmenu spy registered AFTER the suppressor was
    // armed should NOT receive the synthetic event — capture-phase
    // stopImmediatePropagation in longPress eats it before bubble.
    const bubbleSpy = vi.fn();
    document.addEventListener("contextmenu", bubbleSpy);
    const synth = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    document.dispatchEvent(synth);
    document.removeEventListener("contextmenu", bubbleSpy);

    expect(bubbleSpy).not.toHaveBeenCalled();
    // Menu still showing — open state was set by the longPress callback
    // and the suppressor doesn't toggle it back off.
    expect(container.querySelectorAll(".vc-context-menu").length).toBe(1);
  });
});
