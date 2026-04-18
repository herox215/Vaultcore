import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * E2E coverage for #162 — file-reference nodes on canvas:
 *   (1) `[[wiki-link]]` inside a canvas text node resolves to a clickable
 *       link segment that opens the referenced note in a new tab.
 *   (2) Dragging a file from the sidebar tree onto the canvas creates a
 *       file-node at the drop point and persists it to `.canvas` on disk.
 */

const DEBOUNCE_MS = 400;
const FLUSH_WAIT_MS = DEBOUNCE_MS + 500;

interface CanvasDocOnDisk {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

describe("Canvas file-reference nodes (#162)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Linked.canvas"),
      JSON.stringify(
        {
          nodes: [
            {
              id: "t1",
              type: "text",
              x: 0,
              y: 0,
              width: 260,
              height: 60,
              text: "See [[Welcome]] for context",
            },
          ],
          edges: [],
        },
        null,
        "\t",
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(vault.path, "Drop.canvas"),
      JSON.stringify({ nodes: [], edges: [] }, null, "\t"),
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

  it("renders [[target]] in a canvas text node as a clickable link", async () => {
    await openTreeFile("Linked.canvas");
    await waitForActiveTab("Linked.canvas");

    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".vc-canvas-link");
        return els.length >= 1;
      },
      { timeout: 5000, timeoutMsg: "no .vc-canvas-link element rendered for [[Welcome]]" },
    );

    // The sidebar tree fixture has `Welcome.md`, so the link should be resolved.
    const resolved = await browser.$$(".vc-canvas-link-resolved");
    expect(resolved.length).toBeGreaterThanOrEqual(1);
  });

  it("clicking the wiki-link opens the target note in a new tab", async () => {
    // Still on Linked.canvas from the previous test.
    const link = await browser.$(".vc-canvas-link-resolved");
    await link.click();

    await waitForActiveTab("Welcome.md");
    const editor = await browser.$(".cm-content");
    await editor.waitForDisplayed({ timeout: 5000 });
  });

  it("dropping a sidebar file onto the canvas creates a file-node at the drop point", async () => {
    await openTreeFile("Drop.canvas");
    await waitForActiveTab("Drop.canvas");

    // Wait for the viewport to mount.
    await browser.waitUntil(
      async () => {
        const vps = await browser.$$(".vc-canvas-viewport");
        for (const vp of vps) if (await vp.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000, timeoutMsg: "Canvas viewport never displayed for Drop.canvas" },
    );

    // Simulate a drag from the sidebar tree onto the centre of the viewport.
    // Absolute path is what the sidebar's `text/vaultcore-file` payload carries.
    const absPath = path.join(vault.path, "Welcome.md");
    await browser.execute((abs: string) => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const vp = vps.find((v) => v.offsetParent !== null);
      if (!vp) throw new Error("no visible canvas viewport");
      const rect = vp.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;

      const dt = new DataTransfer();
      dt.setData("text/vaultcore-file", abs);
      dt.effectAllowed = "move";

      vp.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer: dt,
        }),
      );
      vp.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer: dt,
        }),
      );
    }, absPath);

    // A new .vc-canvas-node-file should materialise in the DOM.
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
      { timeout: 5000, timeoutMsg: "no file-node appeared after drop" },
    );

    // And it should round-trip to disk with the vault-relative file field.
    const doc = await waitForDiskDoc(
      "Drop.canvas",
      (d) => d.nodes.some((n) => n.type === "file" && n.file === "Welcome.md"),
    );
    const fileNode = doc.nodes.find((n) => n.type === "file");
    expect(fileNode).toBeDefined();
    expect(fileNode!.file).toBe("Welcome.md");
  });
});
