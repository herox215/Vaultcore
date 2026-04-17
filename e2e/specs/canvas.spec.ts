import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * E2E coverage for issue #124 (canvas phase 1). Tests:
 *   - Opening an Obsidian `.canvas` file renders CanvasView instead of CM6.
 *   - Existing text nodes render with their content and position.
 *   - Roundtrip: saving preserves unknown node / edge / top-level fields.
 *   - Create a text card via double-click on empty space.
 *   - Edit a text card via double-click, blur autosaves to disk.
 *   - Delete the selected card via Backspace.
 *   - Empty / non-text-node inputs do not crash the viewer.
 *   - "New canvas here" in the sidebar context menu creates + opens the file.
 *   - Dragging a card persists the new coordinates on disk.
 *
 * Multiple canvas tabs can be open at the same time — most DOM queries
 * therefore scope to the visible (active) viewport via `vizSel(...)` which
 * reads the data-tab-id off the only `.vc-canvas-viewport` whose
 * `offsetParent !== null`. That avoids grabbing a hidden sibling tab.
 */

const DEBOUNCE_MS = 400;
const FLUSH_WAIT_MS = DEBOUNCE_MS + 500; // buffer for the write round-trip

const ROUNDTRIP_DOC = {
  nodes: [
    {
      id: "text-1",
      type: "text",
      x: -120,
      y: -40,
      width: 240,
      height: 80,
      text: "Hallo Canvas",
      styleAttributes: { theme: "dark" },
    },
    {
      id: "group-1",
      type: "group",
      x: 200,
      y: 100,
      width: 300,
      height: 200,
      label: "Gruppe A",
      background: "#112233",
      futureProp: 42,
    },
  ],
  edges: [
    {
      id: "edge-1",
      fromNode: "text-1",
      toNode: "group-1",
      fromSide: "right",
      toSide: "left",
      unknownEdgeField: ["stays"],
    },
  ],
  metadata: { schemaVersion: 2 },
};

describe("Canvas viewer (#124)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Roundtrip.canvas"),
      JSON.stringify(ROUNDTRIP_DOC, null, "\t"),
      "utf-8",
    );
    fs.writeFileSync(path.join(vault.path, "Empty.canvas"), "", "utf-8");
    fs.writeFileSync(
      path.join(vault.path, "Edit.canvas"),
      JSON.stringify({ nodes: [], edges: [] }, null, "\t"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  // ─── Helpers ──────────────────────────────────────────────────────────

  async function activeTabId(): Promise<string> {
    const id = await browser.execute(() => {
      // The viewport has data-tab-id; find the one that is currently visible.
      const viewports = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = viewports.find((v) => v.offsetParent !== null);
      return visible?.getAttribute("data-tab-id") ?? null;
    });
    if (!id) throw new Error("No visible canvas viewport found");
    return id as string;
  }

  /** Builds a selector scoped to the active canvas's viewport. */
  async function vizSel(suffix = ""): Promise<string> {
    const id = await activeTabId();
    return `.vc-canvas-viewport[data-tab-id="${id}"]${suffix}`;
  }

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

  async function readCanvasFromDisk(
    name: string,
  ): Promise<{
    nodes: unknown[];
    edges: unknown[];
    [k: string]: unknown;
  }> {
    const raw = fs.readFileSync(path.join(vault.path, name), "utf-8");
    return JSON.parse(raw);
  }

  async function waitForDiskDoc<T>(
    name: string,
    predicate: (doc: {
      nodes: unknown[];
      edges: unknown[];
      [k: string]: unknown;
    }) => T | null | false | undefined,
    timeoutMs = FLUSH_WAIT_MS * 6,
  ): Promise<T> {
    const start = Date.now();
    let last: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        const doc = await readCanvasFromDisk(name);
        const hit = predicate(doc);
        if (hit) return hit as T;
        last = doc;
      } catch {
        /* file not yet written */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `waitForDiskDoc(${name}) timed out. Last doc: ${JSON.stringify(last)}`,
    );
  }

  async function dispatchDblClick(
    selector: string,
    offsetX?: number,
    offsetY?: number,
  ): Promise<void> {
    await browser.execute(
      (sel: string, ox: number | null, oy: number | null) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`No element: ${sel}`);
        const rect = el.getBoundingClientRect();
        const clientX = ox === null ? rect.left + rect.width / 2 : rect.left + ox;
        const clientY = oy === null ? rect.top + rect.height / 2 : rect.top + oy;
        const ev = new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 0,
        });
        el.dispatchEvent(ev);
      },
      selector,
      offsetX ?? null,
      offsetY ?? null,
    );
  }

  /** Set the active editing textarea's value + fire input + blur. */
  async function typeInActiveTextareaAndBlur(text: string): Promise<void> {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const ta = document.querySelector(".vc-canvas-node-textarea");
          return !!ta;
        }),
      { timeout: 3000, timeoutMsg: "No editing textarea appeared" },
    );
    await browser.execute((t: string) => {
      const ta = document.querySelector(
        ".vc-canvas-node-textarea",
      ) as HTMLTextAreaElement | null;
      if (!ta) throw new Error("No textarea");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, t);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.blur();
    }, text);
  }

  async function pointerClick(selector: string): Promise<void> {
    await browser.execute((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`No element: ${sel}`);
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerId: 2,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }, selector);
  }

  async function pointerDrag(
    selector: string,
    dx: number,
    dy: number,
  ): Promise<void> {
    await browser.execute(
      (sel: string, mx: number, my: number) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`No element: ${sel}`);
        const rect = el.getBoundingClientRect();
        const startX = rect.left + rect.width / 2;
        const startY = rect.top + rect.height / 2;
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
        el.dispatchEvent(new PointerEvent("pointerdown", opts(startX, startY)));
        el.dispatchEvent(
          new PointerEvent("pointermove", opts(startX + mx, startY + my)),
        );
        el.dispatchEvent(
          new PointerEvent("pointerup", opts(startX + mx, startY + my)),
        );
      },
      selector,
      dx,
      dy,
    );
  }

  async function visibleTextNodes(): Promise<number> {
    return browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      if (!visible) return 0;
      return visible.querySelectorAll(".vc-canvas-node-text").length;
    }) as Promise<number>;
  }

  async function visiblePlaceholders(): Promise<number> {
    return browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      if (!visible) return 0;
      return visible.querySelectorAll(".vc-canvas-node-placeholder").length;
    }) as Promise<number>;
  }

  async function visibleTextNodeContent(): Promise<string> {
    return browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      const content = visible?.querySelector(
        ".vc-canvas-node-text .vc-canvas-node-content",
      );
      return content?.textContent?.trim() ?? "";
    }) as Promise<string>;
  }

  // ─── Open + render ────────────────────────────────────────────────────

  it("opens a .canvas file in the canvas viewer (not CM6)", async () => {
    await openTreeFile("Roundtrip.canvas");
    await waitForCanvas();

    const hasCm = await browser.execute(() => {
      const containers = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-editor-container"),
      );
      const active = containers.find((el) => el.offsetParent !== null);
      return !!active?.querySelector(".cm-editor");
    });
    expect(hasCm).toBe(false);
  });

  it("labels the tab with the .canvas filename", async () => {
    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(activeLabel)).toBe("Roundtrip.canvas");
  });

  it("renders existing text nodes with their content", async () => {
    expect(await visibleTextNodes()).toBe(1);
    expect(await visibleTextNodeContent()).toBe("Hallo Canvas");
  });

  it("renders non-text node types as placeholders (round-trip only)", async () => {
    expect(await visiblePlaceholders()).toBe(1);
  });

  // ─── Roundtrip ────────────────────────────────────────────────────────

  it("preserves unknown node, edge, and top-level fields after an edit", async () => {
    // Dbl-click the text card to enter edit mode.
    await dispatchDblClick(await vizSel(" .vc-canvas-node-text"));
    await typeInActiveTextareaAndBlur("Hallo Canvas Bearbeitet");

    const doc = await waitForDiskDoc("Roundtrip.canvas", (d) => {
      const nodes = d.nodes as Array<Record<string, unknown>>;
      const text = nodes.find((n) => n.id === "text-1") as
        | { text?: string }
        | undefined;
      return text?.text?.includes("Bearbeitet") ? d : false;
    });

    const textNode = (doc.nodes as Array<Record<string, unknown>>).find(
      (n) => n.id === "text-1",
    )!;
    const groupNode = (doc.nodes as Array<Record<string, unknown>>).find(
      (n) => n.id === "group-1",
    )!;
    const edge = (doc.edges as Array<Record<string, unknown>>)[0]!;

    expect(textNode.styleAttributes).toEqual({ theme: "dark" });
    expect(groupNode.futureProp).toBe(42);
    expect(groupNode.label).toBe("Gruppe A");
    expect(groupNode.background).toBe("#112233");
    expect(edge.unknownEdgeField).toEqual(["stays"]);
    expect(edge.fromSide).toBe("right");
    expect(edge.toSide).toBe("left");
    expect(doc.metadata).toEqual({ schemaVersion: 2 });
  });

  // ─── Create + edit + delete ───────────────────────────────────────────

  it("creates a new text card on double-click in empty space", async () => {
    await openTreeFile("Edit.canvas");
    await waitForCanvas();

    const before = await visibleTextNodes();

    await dispatchDblClick(await vizSel(), 80, 120);
    await typeInActiveTextareaAndBlur("Erstes Kärtchen");

    await browser.waitUntil(
      async () => (await visibleTextNodes()) === before + 1,
      {
        timeout: 3000,
        timeoutMsg: "Card never appeared after double-click",
      },
    );

    await waitForDiskDoc("Edit.canvas", (d) => {
      const nodes = d.nodes as Array<Record<string, unknown>>;
      return nodes.length === 1 && nodes[0]!.text === "Erstes Kärtchen"
        ? d
        : false;
    });
  });

  it("deletes the selected text card on Backspace", async () => {
    await pointerClick(await vizSel(" .vc-canvas-node-text"));
    await browser.keys(["Backspace"]);

    await browser.waitUntil(
      async () => (await visibleTextNodes()) === 0,
      { timeout: 3000, timeoutMsg: "Card was never removed from DOM" },
    );

    await waitForDiskDoc("Edit.canvas", (d) =>
      (d.nodes as unknown[]).length === 0 ? d : false,
    );
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  it("opens an empty .canvas file without crashing", async () => {
    await openTreeFile("Empty.canvas");
    await waitForCanvas();

    expect(await visibleTextNodes()).toBe(0);
    expect(await visiblePlaceholders()).toBe(0);

    const hasError = await browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      return !!visible?.querySelector(".vc-canvas-error");
    });
    expect(hasError).toBe(false);
  });

  it("creates a new card in the previously-empty canvas and persists it", async () => {
    await dispatchDblClick(await vizSel(), 200, 200);
    await typeInActiveTextareaAndBlur("seed");

    await browser.waitUntil(
      async () => (await visibleTextNodes()) === 1,
      { timeout: 3000, timeoutMsg: "Seeded card never appeared" },
    );
    await waitForDiskDoc("Empty.canvas", (d) => {
      const nodes = d.nodes as Array<Record<string, unknown>>;
      return nodes.length === 1 && nodes[0]!.text === "seed" ? d : false;
    });
  });

  // ─── Sidebar integration ──────────────────────────────────────────────

  it("creates a blank canvas via the 'New canvas here' sidebar menu", async () => {
    const folder = await (async () => {
      const nodes = await browser.$$(".vc-tree-name");
      for (const n of nodes) {
        if ((await textOf(n)) === "subfolder") return n;
      }
      throw new Error("subfolder not in tree");
    })();

    await browser.execute((el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2,
      });
      el.dispatchEvent(ev);
    }, folder);

    await browser.$(".vc-context-menu").waitForDisplayed({ timeout: 3000 });
    const items = await browser.$$(".vc-context-item");
    let clicked = false;
    for (const item of items) {
      if ((await textOf(item)).toLowerCase().includes("canvas")) {
        await item.click();
        clicked = true;
        break;
      }
    }
    expect(clicked).toBe(true);

    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes("Untitled.canvas");
      },
      {
        timeout: 5000,
        timeoutMsg: "'Untitled.canvas' never appeared in tree",
      },
    );

    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(activeLabel)).toBe("Untitled.canvas");

    const disk = JSON.parse(
      fs.readFileSync(
        path.join(vault.path, "subfolder", "Untitled.canvas"),
        "utf-8",
      ),
    );
    expect(disk).toEqual({ nodes: [], edges: [] });

    await waitForCanvas();
  });

  // ─── Move ─────────────────────────────────────────────────────────────

  it("drags a text card and persists the new coordinates", async () => {
    await dispatchDblClick(await vizSel(), 100, 100);
    await typeInActiveTextareaAndBlur("draggable");

    const seeded = await waitForDiskDoc("subfolder/Untitled.canvas", (d) => {
      const nodes = d.nodes as Array<Record<string, unknown>>;
      return nodes.length === 1 && nodes[0]!.text === "draggable" ? d : false;
    });
    const startX = (seeded.nodes as Array<Record<string, unknown>>)[0]!
      .x as number;
    const startY = (seeded.nodes as Array<Record<string, unknown>>)[0]!
      .y as number;

    await pointerDrag(await vizSel(" .vc-canvas-node-text"), 60, 30);

    await waitForDiskDoc("subfolder/Untitled.canvas", (d) => {
      const node = (d.nodes as Array<Record<string, unknown>>)[0]!;
      return (node.x as number) !== startX || (node.y as number) !== startY
        ? d
        : false;
    });
  });
});
