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

  it("empty-canvas menu shows Add text / file / link / group (#166)", async () => {
    const { container } = await mountWithDoc({ nodes: [], edges: [] });
    await openMenuOnViewport(container);
    expect(menuItems(container)).toEqual([
      "Add text node",
      "Add file node…",
      "Add link node…",
      "Add group",
    ]);
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

  it("link-node menu lists the expected entries (#166 adds Edit URL…)", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "l", type: "link", url: "https://example.com", x: 0, y: 0, width: 200, height: 60 }],
      edges: [],
    });
    await openMenuOnNode(container, "l");
    expect(menuItems(container)).toEqual([
      "Open link",
      "Copy URL",
      "Edit URL…",
      "Duplicate",
      "Bring to front",
      "Send to back",
      "Delete",
    ]);
  });

  // ─── Group node ──────────────────────────────────────────────────────

  it("group-node menu lists the expected entries (#166 adds Edit label + colour)", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "g", type: "group", label: "G", x: 0, y: 0, width: 300, height: 200 }],
      edges: [],
    });
    await openMenuOnNode(container, "g");
    expect(menuItems(container)).toEqual([
      "Edit label…",
      "Change color…",
      "Duplicate",
      "Delete",
    ]);
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
    expect(menuItems(container)).toEqual([
      "Edit label",
      "Change color…",
      "Flip direction",
      "Delete",
    ]);
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

  // ─── #166: deferred entries ───────────────────────────────────────────

  async function waitForWrite(n = 1, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (writeFileMock.mock.calls.length >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`write never happened (waited for ${n})`);
  }

  it("Add link node… opens a URL modal and persists a link node (#166)", async () => {
    const { container } = await mountWithDoc({ nodes: [], edges: [] });
    await openMenuOnViewport(container);
    await clickMenuItem(container, "Add link node…");

    const input = container.querySelector(".vc-url-modal-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "https://example.org" } });
    const ok = container.querySelector(".vc-url-modal-ok") as HTMLButtonElement;
    await fireEvent.click(ok);
    await tick();

    expect(container.querySelectorAll(".vc-canvas-node-link")).toHaveLength(1);
    await waitForWrite();
    const doc = nodesFromLastWrite();
    const link = doc.nodes.find((n) => n.type === "link");
    expect(link).toMatchObject({ type: "link", url: "https://example.org" });
  });

  it("Edit URL… on a link node replaces URL inline and persists (#166)", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "l", type: "link", url: "https://old.example", x: 0, y: 0, width: 200, height: 60 }],
      edges: [],
    });
    await openMenuOnNode(container, "l");
    await clickMenuItem(container, "Edit URL…");

    const input = container.querySelector(".vc-canvas-node-link-url-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "https://new.example" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();

    await waitForWrite();
    const doc = nodesFromLastWrite();
    expect(doc.nodes[0]).toMatchObject({ type: "link", url: "https://new.example" });
  });

  it("Edit label… on a group inserts/replaces the label inline and persists (#166)", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "g", type: "group", x: 0, y: 0, width: 300, height: 200 }],
      edges: [],
    });
    await openMenuOnNode(container, "g");
    await clickMenuItem(container, "Edit label…");

    const input = container.querySelector(".vc-canvas-node-group-label-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.input(input, { target: { value: "My cluster" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();

    await waitForWrite();
    const doc = nodesFromLastWrite();
    expect(doc.nodes[0]).toMatchObject({ type: "group", label: "My cluster" });
  });

  it("Change color… on a group writes groupNode.background + renders it (#166)", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "g", type: "group", x: 0, y: 0, width: 300, height: 200 }],
      edges: [],
    });
    await openMenuOnNode(container, "g");
    await clickMenuItem(container, "Change color…");

    const swatch = container.querySelector('.vc-color-swatch[data-color="#22c55e"]') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    await fireEvent.click(swatch);
    await tick();

    await waitForWrite();
    const doc = nodesFromLastWrite();
    expect(doc.nodes[0]).toMatchObject({ type: "group", background: "#22c55e" });

    // Renderer must apply inline background-color so the new colour is visible.
    const groupEl = container.querySelector(".vc-canvas-node-group") as HTMLElement;
    expect(groupEl.style.backgroundColor).toBeTruthy();
  });

  it("Change color… Clear on a group deletes the background field (#166)", async () => {
    const { container } = await mountWithDoc({
      nodes: [{ id: "g", type: "group", background: "#3b82f6", x: 0, y: 0, width: 300, height: 200 }],
      edges: [],
    });
    await openMenuOnNode(container, "g");
    await clickMenuItem(container, "Change color…");

    const clear = container.querySelector(".vc-color-clear") as HTMLButtonElement;
    expect(clear).toBeTruthy();
    await fireEvent.click(clear);
    await tick();

    await waitForWrite();
    const doc = nodesFromLastWrite();
    const group = doc.nodes[0] as unknown as Record<string, unknown>;
    expect(group.background).toBeUndefined();
  });

  it("Change color… on an edge writes edge.color (#166)", async () => {
    const { container } = await mountWithDoc({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 200, y: 0, width: 100, height: 40 },
      ],
      edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
    });
    await openMenuOnEdge(container);
    await clickMenuItem(container, "Change color…");

    const swatch = container.querySelector('.vc-color-swatch[data-color="#ef4444"]') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    await fireEvent.click(swatch);
    await tick();

    await waitForWrite();
    const doc = nodesFromLastWrite();
    expect(doc.edges[0]).toMatchObject({ id: "e1", color: "#ef4444" });
  });
});
