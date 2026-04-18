// #168 — spatial group membership. Dragging a group node also translates
// every node whose bounding box was fully inside the group rect at the
// moment the drag started. Containment is geometric only — no persisted
// parent field — matching Obsidian's behavior.
//
// This spec exercises the end-to-end path: seed a canvas with a group +
// two fully-contained members + one outsider, drag the group, and verify
// on disk that the group + both members shifted by the same delta while
// the outsider stayed put.

import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

const DEBOUNCE_MS = 400;
const FLUSH_WAIT_MS = DEBOUNCE_MS + 500;

// Far-apart coordinates so the test is insensitive to camera / zoom details:
// we only check relative deltas, not absolute on-screen positions.
const GROUP_SEED = {
  nodes: [
    {
      id: "grp",
      type: "group",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      label: "G",
    },
    { id: "inA", type: "text", x: 40, y: 40, width: 100, height: 40, text: "inA" },
    { id: "inB", type: "text", x: 240, y: 320, width: 100, height: 40, text: "inB" },
    { id: "out", type: "text", x: 600, y: 600, width: 100, height: 40, text: "out" },
  ],
  edges: [],
};

describe("Canvas group movement (#168)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Group.canvas"),
      JSON.stringify(GROUP_SEED, null, "\t"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openTreeFile(name: string): Promise<void> {
    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes(name);
      },
      { timeout: 5000, timeoutMsg: `"${name}" never appeared in the tree` },
    );
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`"${name}" not found`);
  }

  async function waitForCanvas(): Promise<void> {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const vps = Array.from(
            document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
          );
          const visible = vps.find((v) => v.offsetParent !== null);
          return !!visible?.querySelector(".vc-canvas-world");
        }),
      { timeout: 5000, timeoutMsg: "Canvas world never mounted" },
    );
  }

  async function readDoc(): Promise<{ nodes: Array<Record<string, unknown>> }> {
    const raw = fs.readFileSync(path.join(vault.path, "Group.canvas"), "utf-8");
    return JSON.parse(raw);
  }

  async function waitForGroupAtOrigin(x0: number, y0: number): Promise<void> {
    const deadline = Date.now() + FLUSH_WAIT_MS * 6;
    let last: Array<Record<string, unknown>> | null = null;
    while (Date.now() < deadline) {
      try {
        const doc = await readDoc();
        const grp = doc.nodes.find((n) => n.id === "grp")!;
        if (grp.x !== x0 || grp.y !== y0) return;
        last = doc.nodes;
      } catch {
        /* file race */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `group never moved from (${x0}, ${y0}). Last nodes: ${JSON.stringify(last)}`,
    );
  }

  // Drag the group node by (dx, dy) pixels. We start the pointer on the
  // group's top-left quadrant — well clear of inner text nodes — so the
  // event fires on the group element rather than a child card.
  async function dragGroup(dx: number, dy: number): Promise<void> {
    await browser.execute(
      (mx: number, my: number) => {
        const vps = Array.from(
          document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
        );
        const visible = vps.find((v) => v.offsetParent !== null)!;
        const grp = visible.querySelector<HTMLElement>(
          '[data-node-id="grp"]',
        )!;
        const rect = grp.getBoundingClientRect();
        // 15% in from the top-left corner — guaranteed to miss inA at (40,40)
        // relative to group origin (which maps to ~10% of the 400-wide rect).
        const startX = rect.left + rect.width * 0.05;
        const startY = rect.top + rect.height * 0.05;
        const opts = (x: number, y: number): PointerEventInit => ({
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons: 1,
          isPrimary: true,
        });
        grp.dispatchEvent(new PointerEvent("pointerdown", opts(startX, startY)));
        // Move past the long-press threshold so we fall into move mode rather
        // than waiting for the 300ms pan-timer.
        grp.dispatchEvent(
          new PointerEvent("pointermove", opts(startX + mx, startY + my)),
        );
        grp.dispatchEvent(
          new PointerEvent("pointerup", opts(startX + mx, startY + my)),
        );
      },
      dx,
      dy,
    );
  }

  it("translates contained nodes with the group and leaves outsiders alone", async () => {
    await openTreeFile("Group.canvas");
    await waitForCanvas();

    // Sanity: pre-drag positions on disk match the seed.
    const before = await readDoc();
    const grpB = before.nodes.find((n) => n.id === "grp")!;
    const inAB = before.nodes.find((n) => n.id === "inA")!;
    const inBB = before.nodes.find((n) => n.id === "inB")!;
    const outB = before.nodes.find((n) => n.id === "out")!;
    expect(grpB.x).toBe(0);
    expect(grpB.y).toBe(0);
    expect(inAB.x).toBe(40);
    expect(inBB.x).toBe(240);
    expect(outB.x).toBe(600);

    await dragGroup(60, 30);

    // Wait for any change before diffing.
    await waitForGroupAtOrigin(0, 0);
    const after = await readDoc();
    const grpA = after.nodes.find((n) => n.id === "grp")!;
    const inAA = after.nodes.find((n) => n.id === "inA")!;
    const inBA = after.nodes.find((n) => n.id === "inB")!;
    const outA = after.nodes.find((n) => n.id === "out")!;

    const dx = (grpA.x as number) - 0;
    const dy = (grpA.y as number) - 0;
    // Sanity: the group actually moved.
    expect(dx).not.toBe(0);

    // Both members tracked the group by the same delta.
    expect((inAA.x as number) - 40).toBe(dx);
    expect((inAA.y as number) - 40).toBe(dy);
    expect((inBA.x as number) - 240).toBe(dx);
    expect((inBA.y as number) - 320).toBe(dy);

    // Outsider stayed put.
    expect(outA.x).toBe(600);
    expect(outA.y).toBe(600);
  });
});
