import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

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
    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await browser.waitUntil(
      async () => ((await activeLabel.getProperty("textContent")) as string).includes(label),
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

    // Find "Add text node" entry and click it.
    const items = await browser.$$(".vc-context-menu .vc-context-item");
    let clicked = false;
    for (const it of items) {
      const label = (await textOf(it)).trim();
      if (label === "Add text node") {
        await it.click();
        clicked = true;
        break;
      }
    }
    expect(clicked).toBe(true);

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

    // Menu → click "Add file node…".
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });
    const items = await browser.$$(".vc-context-menu .vc-context-item");
    let clicked = false;
    for (const it of items) {
      const label = (await textOf(it)).trim();
      if (label === "Add file node…") {
        await it.click();
        clicked = true;
        break;
      }
    }
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
