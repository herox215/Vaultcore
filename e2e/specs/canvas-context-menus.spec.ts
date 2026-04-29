import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * E2E for #164 — canvas context menus.
 *
 * Acceptance-criteria regression guard for the empty-canvas → "Add text node"
 * flow: right-click the empty canvas surface, click the menu entry, verify a
 * new text node materialises in the DOM and persists to the `.canvas` file on
 * disk with `type: "text"`.
 */

const DEBOUNCE_MS = 400;
const FLUSH_WAIT_MS = DEBOUNCE_MS + 500;

interface CanvasDocOnDisk {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

describe("Canvas context menus (#164)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Menu.canvas"),
      JSON.stringify({ nodes: [], edges: [] }, null, "\t"),
      "utf-8",
    );
    // #166: a reachable vault file so the "Add file node…" QuickSwitcher
    // has something to return on the first Enter keystroke.
    fs.writeFileSync(
      path.join(vault.path, "Target.md"),
      "# Target\n\nA file to embed.\n",
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
        const nodes = await browser.$$(".vc-tree-name");
        for (const n of nodes) if ((await textOf(n)) === name) return true;
        return false;
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

  async function waitForActiveTab(label: string, timeout = 5000) {
    // Re-query each iteration — the `.vc-tab--active` element is replaced
    // on every tab switch and a handle captured before the transition
    // would silently keep returning the old label.
    await browser.waitUntil(
      async () => {
        const labels = await textsOf(await browser.$$(".vc-tab--active .vc-tab-label"));
        return labels.some((l) => l.includes(label));
      },
      { timeout, timeoutMsg: `active tab never switched to "${label}"` },
    );
  }

  async function waitForDiskDoc(
    name: string,
    predicate: (doc: CanvasDocOnDisk) => boolean,
    timeoutMs = FLUSH_WAIT_MS * 6,
  ): Promise<CanvasDocOnDisk> {
    const start = Date.now();
    let last: CanvasDocOnDisk | null = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const raw = fs.readFileSync(path.join(vault.path, name), "utf-8");
        const doc = JSON.parse(raw) as CanvasDocOnDisk;
        if (predicate(doc)) return doc;
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

  it("right-click empty canvas → Add text node → creates a node and persists", async () => {
    await openTreeFile("Menu.canvas");
    await waitForActiveTab("Menu.canvas");

    // Wait for the viewport to mount.
    await browser.waitUntil(
      async () => {
        const vps = await browser.$$(".vc-canvas-viewport");
        for (const vp of vps) if (await vp.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000, timeoutMsg: "Canvas viewport never displayed" },
    );

    // Dispatch a contextmenu event at the centre of the viewport.
    const clickPoint = await browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const vp = vps.find((v) => v.offsetParent !== null);
      if (!vp) throw new Error("no visible canvas viewport");
      const rect = vp.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      vp.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 2,
        }),
      );
      return { x: clientX, y: clientY };
    });

    // Menu should appear.
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });

    // #362: "Add text node" opens an inline shape picker — the node is
    // only created when a shape is then chosen. Two clicks total, both
    // via JS dispatch (overlay-click guard).
    const expanded = await browser.execute(() => {
      const items = document.querySelectorAll<HTMLElement>(
        ".vc-context-menu .vc-context-item",
      );
      for (const el of Array.from(items)) {
        if ((el.textContent ?? "").trim() === "Add text node") {
          el.click();
          return true;
        }
      }
      return false;
    });
    expect(expanded).toBe(true);

    // Wait for the picker to appear, THEN click — never click inside the
    // poll predicate (that turns the wait into N rapid-fire clicks).
    await browser.waitUntil(
      async () =>
        (await browser.$$(".vc-shape-picker-row")).length > 0,
      { timeout: 3000, timeoutMsg: "shape picker never expanded after Add text node" },
    );
    const picked = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>(".vc-shape-picker-row");
      if (!row) return false;
      row.click();
      return true;
    });
    expect(picked).toBe(true);

    // A text node should materialise in the active canvas viewport.
    await browser.waitUntil(
      async () => {
        const n = await browser.execute(() => {
          const vps = Array.from(
            document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
          );
          const vp = vps.find((v) => v.offsetParent !== null);
          return vp?.querySelectorAll(".vc-canvas-node-text").length ?? 0;
        });
        return (n as number) >= 1;
      },
      { timeout: 5000, timeoutMsg: "no text node appeared after Add text node" },
    );

    // Persist to disk as a text node (position is at the click point; we only
    // assert the type since the world-coordinate will depend on camera origin).
    const doc = await waitForDiskDoc(
      "Menu.canvas",
      (d) => d.nodes.some((n) => n.type === "text"),
    );
    expect(doc.nodes.some((n) => n.type === "text")).toBe(true);
    // The empty node should have been written with an empty text field.
    const textNode = doc.nodes.find((n) => n.type === "text");
    expect(typeof textNode!.id).toBe("string");

    // Silence the unused capture warning.
    void clickPoint;
  });

  it("right-click empty canvas → Add file node… → picks a file and persists (#166)", async () => {
    // Re-seed the canvas so this test is independent of the first one's
    // mutation — the previous test left a text node on the canvas.
    fs.writeFileSync(
      path.join(vault.path, "Menu.canvas"),
      JSON.stringify({ nodes: [], edges: [] }, null, "\t"),
      "utf-8",
    );
    // Close and re-open the canvas tab by clicking the file in the tree.
    await openTreeFile("Menu.canvas");
    await waitForActiveTab("Menu.canvas");

    await browser.waitUntil(
      async () => {
        const vps = await browser.$$(".vc-canvas-viewport");
        for (const vp of vps) if (await vp.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000, timeoutMsg: "Canvas viewport never displayed" },
    );

    // Dispatch a contextmenu event at the centre of the canvas viewport.
    await browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const vp = vps.find((v) => v.offsetParent !== null);
      if (!vp) throw new Error("no visible canvas viewport");
      const rect = vp.getBoundingClientRect();
      vp.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          button: 2,
        }),
      );
    });

    // Menu → click "Add file node…" via JS dispatch (overlay-click guard).
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });
    const clicked = await browser.execute((label: string) => {
      const items = document.querySelectorAll<HTMLElement>(
        ".vc-context-menu .vc-context-item",
      );
      for (const el of Array.from(items)) {
        if ((el.textContent ?? "").trim() === label) {
          el.click();
          return true;
        }
      }
      return false;
    }, "Add file node…");
    expect(clicked).toBe(true);

    // QuickSwitcher opens — type the target file name and press Enter.
    const qsInput = await browser.$(".vc-qs-input");
    await qsInput.waitForDisplayed({ timeout: 3000 });
    await qsInput.setValue("Target");
    await browser.waitUntil(
      async () => {
        const rows = await browser.$$(".vc-qs-results > *");
        return rows.length > 0;
      },
      { timeout: 3000, timeoutMsg: "quick switcher returned no results" },
    );
    await browser.keys("Enter");

    // A file node materialises in the canvas.
    await browser.waitUntil(
      async () => {
        const n = await browser.execute(() => {
          const vps = Array.from(
            document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
          );
          const vp = vps.find((v) => v.offsetParent !== null);
          return vp?.querySelectorAll(".vc-canvas-node-file").length ?? 0;
        });
        return (n as number) >= 1;
      },
      { timeout: 5000, timeoutMsg: "no file node appeared after Add file node" },
    );

    // Persist to disk as a file node pointing at Target.md.
    const doc = await waitForDiskDoc(
      "Menu.canvas",
      (d) => d.nodes.some((n) => n.type === "file" && typeof n.file === "string"),
    );
    const fileNode = doc.nodes.find((n) => n.type === "file");
    expect(fileNode).toBeDefined();
    expect((fileNode as Record<string, unknown>).file).toMatch(/Target\.md$/);
  });
});
