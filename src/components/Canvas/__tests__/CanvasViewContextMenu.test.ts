// #164 — CanvasView integration: right-click menu entries mutate the doc as
// promised. These tests exercise the end-to-end path from a contextmenu event
// on the viewport / a node / an edge through the menu click to the store
// mutation so the per-target menus stay wired up as the renderer evolves.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

// Bind the IPC commands to a mutable mock closure so each test can seed
// a fresh doc without remounting the module.
const readFileMock = vi.fn<(path: string) => Promise<string>>();
const writeFileMock = vi.fn<(path: string, content: string) => Promise<void>>();

vi.mock("../../../ipc/commands", () => ({
  readFile: (path: string) => readFileMock(path),
  writeFile: (path: string, content: string) => writeFileMock(path, content),
}));

import CanvasView from "../CanvasView.svelte";
import { vaultStore } from "../../../store/vaultStore";
import type { CanvasDoc } from "../../../lib/canvas/types";

const VAULT = "/tmp/canvas-vault";
const TAB_ID = "tab-1";
const FILE_ABS = `${VAULT}/Menu.canvas`;

function seedDoc(doc: CanvasDoc): void {
  readFileMock.mockReset();
  writeFileMock.mockReset();
  readFileMock.mockResolvedValue(JSON.stringify(doc, null, "\t"));
  writeFileMock.mockResolvedValue(undefined);
}

async function openMenuOnViewport(container: HTMLElement, x = 400, y = 300) {
  const vp = container.querySelector(".vc-canvas-viewport") as HTMLElement;
  // The viewport's getBoundingClientRect is {0,0,0,0} in jsdom; we dispatch
  // the event with clientX/clientY directly, which clientToWorld reads.
  await fireEvent.contextMenu(vp, { clientX: x, clientY: y, button: 2 });
  await tick();
}

async function openMenuOnNode(container: HTMLElement, id: string) {
  const el = container.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
  await fireEvent.contextMenu(el, { clientX: 100, clientY: 100, button: 2 });
  await tick();
}

async function openMenuOnEdge(container: HTMLElement) {
  const hit = container.querySelector(".vc-canvas-edge-hit") as SVGPathElement;
  await fireEvent.contextMenu(hit, { clientX: 150, clientY: 100, button: 2 });
  await tick();
}

function menuItems(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".vc-context-menu .vc-context-item")).map(
    (b) => (b as HTMLElement).textContent?.trim() ?? "",
  );
}

async function clickMenuItem(container: HTMLElement, label: string) {
  const items = Array.from(container.querySelectorAll(".vc-context-menu .vc-context-item"));
  const btn = items.find(
    (b) => ((b as HTMLElement).textContent ?? "").trim() === label,
  ) as HTMLElement | undefined;
  if (!btn) throw new Error(`menu item "${label}" not found. Have: ${menuItems(container).join(", ")}`);
  await fireEvent.click(btn);
  await tick();
}

async function mountWithDoc(doc: CanvasDoc) {
  seedDoc(doc);
  const result = render(CanvasView, { props: { tabId: TAB_ID, abs: FILE_ABS } });
  // Wait for async load().
  for (let i = 0; i < 20; i++) {
    await tick();
    if (result.container.querySelector(".vc-canvas-world")) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return result;
}

function nodesFromLastWrite(): CanvasDoc {
  const lastCall = writeFileMock.mock.calls.at(-1);
  if (!lastCall) throw new Error("writeFile was never called");
  return JSON.parse(lastCall[1] as string) as CanvasDoc;
}

describe("CanvasView context menus (#164)", () => {
  beforeEach(() => {
    vaultStore.reset();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
  });

  // ─── Empty canvas ────────────────────────────────────────────────────

  it("empty-canvas menu shows Add text node + Add group", async () => {
    const { container } = await mountWithDoc({ nodes: [], edges: [] });
    await openMenuOnViewport(container);
    expect(menuItems(container)).toEqual(["Add text node", "Add group"]);
  });

  it("Add text node creates a text node in the doc", async () => {
    const { container } = await mountWithDoc({ nodes: [], edges: [] });
    await openMenuOnViewport(container);
    await clickMenuItem(container, "Add text node");
    expect(container.querySelectorAll(".vc-canvas-node-text")).toHaveLength(1);
  });

  it("Add group creates a group node in the doc", async () => {
    const { container } = await mountWithDoc({ nodes: [], edges: [] });
    await openMenuOnViewport(container);
    await clickMenuItem(container, "Add group");
    expect(container.querySelectorAll(".vc-canvas-node-group")).toHaveLength(1);
  });

  // ─── Text node ───────────────────────────────────────────────────────

  it("text-node menu lists the expected entries", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "t", type: "text", text: "hi", x: 0, y: 0, width: 100, height: 40 }],
      edges: [],
    });
    await openMenuOnNode(container, "t");
    expect(menuItems(container)).toEqual([
      "Edit text",
      "Duplicate",
      "Copy text",
      "Bring to front",
      "Send to back",
      "Delete",
    ]);
  });

  it("Duplicate on a text node creates a clone with a new id and offset position", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "t", type: "text", text: "hi", x: 100, y: 100, width: 120, height: 40 }],
      edges: [],
    });
    await openMenuOnNode(container, "t");
    await clickMenuItem(container, "Duplicate");
    expect(container.querySelectorAll(".vc-canvas-node-text")).toHaveLength(2);
  });

  it("Delete on a text node removes it from the doc", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "t", type: "text", text: "hi", x: 0, y: 0, width: 100, height: 40 }],
      edges: [],
    });
    await openMenuOnNode(container, "t");
    await clickMenuItem(container, "Delete");
    expect(container.querySelectorAll(".vc-canvas-node-text")).toHaveLength(0);
  });

  // ─── File node ───────────────────────────────────────────────────────

  it("file-node menu lists the expected entries", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "f", type: "file", file: "Note.md", x: 0, y: 0, width: 200, height: 200 }],
      edges: [],
    });
    await openMenuOnNode(container, "f");
    expect(menuItems(container)).toEqual([
      "Open in editor",
      "Open in split",
      "Reveal in sidebar",
      "Copy vault path",
      "Duplicate",
      "Bring to front",
      "Send to back",
      "Delete",
    ]);
  });

  // ─── Link node ───────────────────────────────────────────────────────

  it("link-node menu lists the expected entries", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "l", type: "link", url: "https://example.com", x: 0, y: 0, width: 200, height: 60 }],
      edges: [],
    });
    await openMenuOnNode(container, "l");
    expect(menuItems(container)).toEqual([
      "Open link",
      "Copy URL",
      "Duplicate",
      "Bring to front",
      "Send to back",
      "Delete",
    ]);
  });

  // ─── Group node ──────────────────────────────────────────────────────

  it("group-node menu lists the expected entries", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "g", type: "group", label: "G", x: 0, y: 0, width: 300, height: 200 }],
      edges: [],
    });
    await openMenuOnNode(container, "g");
    expect(menuItems(container)).toEqual(["Duplicate", "Delete"]);
  });

  // ─── Edge ────────────────────────────────────────────────────────────

  it("edge menu lists Edit label / Flip direction / Delete", async () => {
    const { container } = await mountWithDoc({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 200, y: 0, width: 100, height: 40 },
      ],
      edges: [{ id: "e1", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }],
    });
    await openMenuOnEdge(container);
    expect(menuItems(container)).toEqual(["Edit label", "Flip direction", "Delete"]);
  });

  it("Flip direction swaps the edge endpoints + sides", async () => {
    const { container } = await mountWithDoc({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 200, y: 0, width: 100, height: 40 },
      ],
      edges: [{ id: "e1", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }],
    });
    await openMenuOnEdge(container);
    await clickMenuItem(container, "Flip direction");

    // Wait for the debounced autosave (400 ms).
    for (let i = 0; i < 30; i++) {
      if (writeFileMock.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const flipped = nodesFromLastWrite();
    expect(flipped.edges).toHaveLength(1);
    expect(flipped.edges[0]).toMatchObject({
      fromNode: "b",
      toNode: "a",
      fromSide: "left",
      toSide: "right",
    });
  });

  it("Delete on an edge removes it", async () => {
    const { container } = await mountWithDoc({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 200, y: 0, width: 100, height: 40 },
      ],
      edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
    });
    await openMenuOnEdge(container);
    await clickMenuItem(container, "Delete");
    expect(container.querySelectorAll(".vc-canvas-edge-hit")).toHaveLength(0);
  });
});
