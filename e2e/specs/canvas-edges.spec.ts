import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * E2E coverage for issue #125 (canvas phase 2 — edges). Tests:
 *   - Existing edges render as SVG bezier paths between their endpoint nodes.
 *   - Edges without fromSide/toSide auto-pick and still render.
 *   - Orphaned edges (endpoint node missing) skip silently — no crash.
 *   - Self-loop edges (fromNode === toNode) render without crashing.
 *   - Edge labels display + edit via double-click; blur persists to disk.
 *   - Unknown per-edge fields roundtrip through an edit.
 *   - Creating an edge by dragging from one node handle onto another
 *     node handle writes a new edge to disk.
 *   - Selecting an edge (click on the hit path) + Delete/Backspace removes
 *     it from disk.
 *   - Color + arrow-end passthrough survives an unrelated edit.
 *
 * Scope to the active viewport via vizSel() just like phase 1 — multiple
 * canvas tabs can be open in one suite run.
 */

const DEBOUNCE_MS = 400;
const FLUSH_WAIT_MS = DEBOUNCE_MS + 500;

// Source doc has several edge variants covered by the spec invariants.
const EDGES_DOC = {
  nodes: [
    { id: "n-a", type: "text", x: -400, y: -40, width: 160, height: 60, text: "A" },
    { id: "n-b", type: "text", x: 100, y: -40, width: 160, height: 60, text: "B" },
    { id: "n-c", type: "text", x: -150, y: 200, width: 160, height: 60, text: "C" },
    { id: "n-d", type: "text", x: 400, y: 200, width: 160, height: 60, text: "D" },
  ],
  edges: [
    // explicit sides + color + label + arrow end
    {
      id: "e-explicit",
      fromNode: "n-a",
      toNode: "n-b",
      fromSide: "right",
      toSide: "left",
      color: "#ff8800",
      label: "flow",
      toEnd: "arrow",
      extraFuturey: { foo: 1 },
    },
    // no sides → auto-picked; explicit toEnd: "none" to verify the arrow
    // defaults can be suppressed (Obsidian defaults to arrow-on for toEnd).
    { id: "e-auto", fromNode: "n-b", toNode: "n-c", toEnd: "none" },
    // orphan — toNode missing from the doc
    { id: "e-orphan", fromNode: "n-a", toNode: "ghost" },
    // self-loop
    {
      id: "e-self",
      fromNode: "n-d",
      toNode: "n-d",
      fromSide: "right",
      toSide: "bottom",
    },
  ],
  metadata: { docLevel: true },
};

const CREATE_DOC = {
  nodes: [
    { id: "n-x", type: "text", x: -200, y: 0, width: 160, height: 60, text: "X" },
    { id: "n-y", type: "text", x: 200, y: 0, width: 160, height: 60, text: "Y" },
  ],
  edges: [],
};

describe("Canvas edges (#125)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Edges.canvas"),
      JSON.stringify(EDGES_DOC, null, "\t"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(vault.path, "Create.canvas"),
      JSON.stringify(CREATE_DOC, null, "\t"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  // ─── Helpers (mirror canvas.spec.ts patterns) ─────────────────────────

  async function activeTabId(): Promise<string> {
    const id = await browser.execute(() => {
      const viewports = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = viewports.find((v) => v.offsetParent !== null);
      return visible?.getAttribute("data-tab-id") ?? null;
    });
    if (!id) throw new Error("No visible canvas viewport found");
    return id as string;
  }

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

  async function readDisk(
    name: string,
  ): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    [k: string]: unknown;
  }> {
    const raw = fs.readFileSync(path.join(vault.path, name), "utf-8");
    return JSON.parse(raw);
  }

  async function waitForDiskDoc<T>(
    name: string,
    predicate: (doc: {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      [k: string]: unknown;
    }) => T | null | false | undefined,
    timeoutMs = FLUSH_WAIT_MS * 8,
  ): Promise<T> {
    const start = Date.now();
    let last: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        const doc = await readDisk(name);
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

  /** Count visible edges by data-edge-id on `.vc-canvas-edge` (the visible stroke). */
  async function visibleEdgeCount(): Promise<number> {
    return browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      return visible?.querySelectorAll(".vc-canvas-edge").length ?? 0;
    }) as Promise<number>;
  }

  async function visibleEdgeIds(): Promise<string[]> {
    return browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      if (!visible) return [];
      const paths = Array.from(
        visible.querySelectorAll<SVGElement>(".vc-canvas-edge"),
      );
      return paths.map((p) => p.getAttribute("data-edge-id") ?? "");
    }) as Promise<string[]>;
  }

  async function edgePathD(edgeId: string): Promise<string> {
    return browser.execute((id: string) => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      if (!visible) return "";
      const el = visible.querySelector(
        `.vc-canvas-edge[data-edge-id="${id}"]`,
      ) as SVGPathElement | null;
      return el?.getAttribute("d") ?? "";
    }, edgeId) as Promise<string>;
  }

  async function edgeHasArrow(edgeId: string): Promise<boolean> {
    return browser.execute((id: string) => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      if (!visible) return false;
      const el = visible.querySelector(
        `.vc-canvas-edge[data-edge-id="${id}"]`,
      ) as SVGPathElement | null;
      return !!el?.getAttribute("marker-end");
    }, edgeId) as Promise<boolean>;
  }

  async function visibleEdgeLabelText(): Promise<string[]> {
    return browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      if (!visible) return [];
      return Array.from(visible.querySelectorAll(".vc-canvas-edge-label")).map(
        (e) => e.textContent?.trim() ?? "",
      );
    }) as Promise<string[]>;
  }

  /** Dispatch a synthetic pointerdown + pointermove + pointerup chain to drag
   * from `fromSel` center to `toSel` center, invoking handlers on each
   * element along the way. Used to create an edge without flaky Actions API. */
  async function dragBetween(
    fromSel: string,
    toSel: string,
  ): Promise<void> {
    await browser.execute(
      (from: string, to: string) => {
        const a = document.querySelector(from) as HTMLElement | null;
        const b = document.querySelector(to) as HTMLElement | null;
        if (!a) throw new Error(`No element: ${from}`);
        if (!b) throw new Error(`No element: ${to}`);
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const ax = ra.left + ra.width / 2;
        const ay = ra.top + ra.height / 2;
        const bx = rb.left + rb.width / 2;
        const by = rb.top + rb.height / 2;

        const vp = document.querySelector(
          ".vc-canvas-viewport[data-tab-id]",
        ) as HTMLElement | null;
        // Find the visible viewport
        const vps = Array.from(
          document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
        );
        const visibleVp = vps.find((v) => v.offsetParent !== null) ?? vp;
        if (!visibleVp) throw new Error("No visible viewport");

        const mk = (x: number, y: number): PointerEventInit => ({
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          pointerId: 17,
          pointerType: "mouse",
          button: 0,
          buttons: 1,
          isPrimary: true,
        });

        // pointerdown on source handle
        a.dispatchEvent(new PointerEvent("pointerdown", mk(ax, ay)));
        // move along the viewport (that's where pointermove is captured)
        visibleVp.dispatchEvent(new PointerEvent("pointermove", mk(bx, by)));
        // pointerenter onto target handle (triggers snap)
        b.dispatchEvent(new PointerEvent("pointerenter", mk(bx, by)));
        b.dispatchEvent(new PointerEvent("pointermove", mk(bx, by)));
        // Release on the viewport (which owns the pointer capture for edge mode)
        visibleVp.dispatchEvent(new PointerEvent("pointerup", mk(bx, by)));
      },
      fromSel,
      toSel,
    );
  }

  async function dispatchDblClick(sel: string): Promise<void> {
    await browser.execute((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) throw new Error(`No element: ${s}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          button: 0,
        }),
      );
    }, sel);
  }

  async function pointerClick(sel: string): Promise<void> {
    await browser.execute((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) throw new Error(`No element: ${s}`);
      const r = el.getBoundingClientRect();
      const opts: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        pointerId: 5,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }, sel);
  }

  async function setEdgeLabelInputAndBlur(text: string): Promise<void> {
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !!document.querySelector(".vc-canvas-edge-label-input"),
        ),
      { timeout: 3000, timeoutMsg: "Edge label input never appeared" },
    );
    await browser.execute((t: string) => {
      const inp = document.querySelector(
        ".vc-canvas-edge-label-input",
      ) as HTMLInputElement | null;
      if (!inp) throw new Error("No edge label input");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(inp, t);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.blur();
    }, text);
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  it("renders an edge for every resolvable fromNode/toNode pair", async () => {
    await openTreeFile("Edges.canvas");
    await waitForCanvas();

    await browser.waitUntil(async () => (await visibleEdgeCount()) >= 3, {
      timeout: 3000,
      timeoutMsg: "Edges never appeared",
    });

    const ids = await visibleEdgeIds();
    // explicit, auto, self — orphan (e-orphan) must be skipped, not rendered
    expect(ids).toContain("e-explicit");
    expect(ids).toContain("e-auto");
    expect(ids).toContain("e-self");
    expect(ids).not.toContain("e-orphan");
  });

  it("orphaned edges do not crash the viewer", async () => {
    // If we got here, nothing crashed. Verify the document is intact.
    const hasError = await browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      return !!visible?.querySelector(".vc-canvas-error");
    });
    expect(hasError).toBe(false);
  });

  it("renders a cubic bezier with the fromNode's right side as start", async () => {
    // n-a is at x=-400,y=-40,w=160,h=60. Its `right` anchor = (-240, -10).
    const d = await edgePathD("e-explicit");
    expect(d).toMatch(/^M -240 -10 C /);
    expect(d).toMatch(/100 -10$/); // n-b's `left` anchor = (100, -10)
  });

  it("renders an arrowhead when toEnd === 'arrow'", async () => {
    expect(await edgeHasArrow("e-explicit")).toBe(true);
    expect(await edgeHasArrow("e-auto")).toBe(false);
  });

  it("renders an edge label when the edge has one", async () => {
    const labels = await visibleEdgeLabelText();
    expect(labels).toContain("flow");
  });

  // ─── Edge creation ────────────────────────────────────────────────────

  it("creates a new edge by dragging from one handle onto another", async () => {
    await openTreeFile("Create.canvas");
    await waitForCanvas();

    const before = await visibleEdgeCount();
    expect(before).toBe(0);

    const sel = await vizSel();
    const fromSel = `${sel} [data-node-id="n-x"] [data-edge-handle="right"]`;
    const toSel = `${sel} [data-node-id="n-y"] [data-edge-handle="left"]`;
    await dragBetween(fromSel, toSel);

    await browser.waitUntil(async () => (await visibleEdgeCount()) === 1, {
      timeout: 3000,
      timeoutMsg: "New edge never appeared after drag",
    });

    const doc = await waitForDiskDoc("Create.canvas", (d) =>
      d.edges.length === 1 ? d : false,
    );
    const edge = doc.edges[0]!;
    expect(edge.fromNode).toBe("n-x");
    expect(edge.toNode).toBe("n-y");
    expect(edge.fromSide).toBe("right");
    expect(edge.toSide).toBe("left");
  });

  it("selects an edge on click and deletes it on Backspace", async () => {
    // The edge we just created is the only one in this doc.
    const hitSel = await vizSel(" .vc-canvas-edge-hit");
    await pointerClick(hitSel);

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const vps = Array.from(
            document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
          );
          const visible = vps.find((v) => v.offsetParent !== null);
          return !!visible?.querySelector(".vc-canvas-edge-selected");
        }),
      { timeout: 2000, timeoutMsg: "Edge never became selected" },
    );

    await browser.keys(["Backspace"]);

    await browser.waitUntil(async () => (await visibleEdgeCount()) === 0, {
      timeout: 3000,
      timeoutMsg: "Edge was not removed from DOM",
    });

    await waitForDiskDoc("Create.canvas", (d) =>
      d.edges.length === 0 ? d : false,
    );
  });

  // ─── Label editing ────────────────────────────────────────────────────

  it("edits an edge label via double-click and persists it", async () => {
    await openTreeFile("Edges.canvas");
    await waitForCanvas();

    // Double-click the existing label to enter edit mode.
    await browser.waitUntil(
      async () => (await visibleEdgeLabelText()).includes("flow"),
      { timeout: 3000, timeoutMsg: "Label 'flow' never rendered" },
    );
    await dispatchDblClick(await vizSel(" .vc-canvas-edge-label"));
    await setEdgeLabelInputAndBlur("renamed");

    await browser.waitUntil(
      async () => (await visibleEdgeLabelText()).includes("renamed"),
      { timeout: 3000, timeoutMsg: "Renamed label never appeared" },
    );

    await waitForDiskDoc("Edges.canvas", (d) => {
      const edge = d.edges.find((e) => e.id === "e-explicit");
      return edge && edge.label === "renamed" ? d : false;
    });
  });

  it("preserves unknown edge fields, color and arrow end after an edit", async () => {
    // Check the disk doc from the last assertion — it must still have color,
    // toEnd, and the extraFuturey passthrough alongside the renamed label.
    const doc = await readDisk("Edges.canvas");
    const edge = doc.edges.find((e) => e.id === "e-explicit")!;
    expect(edge.color).toBe("#ff8800");
    expect(edge.toEnd).toBe("arrow");
    expect(edge.extraFuturey).toEqual({ foo: 1 });
    // The self-loop edge should still be present verbatim
    const self = doc.edges.find((e) => e.id === "e-self")!;
    expect(self.fromNode).toBe("n-d");
    expect(self.toNode).toBe("n-d");
    // Top-level unknown key still there
    expect(doc.metadata).toEqual({ docLevel: true });
  });

  it("preserves the orphaned edge on disk even though it is not rendered", async () => {
    const doc = await readDisk("Edges.canvas");
    const orphan = doc.edges.find((e) => e.id === "e-orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.toNode).toBe("ghost");
  });
});
