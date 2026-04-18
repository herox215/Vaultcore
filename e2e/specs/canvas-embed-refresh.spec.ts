import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * E2E coverage for #154 — an inline `![[board]]` embed must re-render
 * when the underlying `.canvas` file changes. After #156 the embed
 * mounts the shared CanvasRenderer, so we count `.vc-canvas-node` DIVs
 * instead of raw <rect> elements. Scenario:
 *   1. Seed Board.canvas with one node and Host.md that embeds it.
 *   2. Open Host.md — assert one .vc-canvas-node in the embed.
 *   3. Overwrite Board.canvas on disk with two nodes (simulates external
 *      edit; the watcher fires listenFileChange on the frontend, the
 *      embedPlugin drops the cache and kicks a rebuild).
 *   4. Assert the embed now paints two .vc-canvas-nodes — no user interaction.
 */

const ONE_NODE = {
  nodes: [{ id: "a", type: "text", text: "Alpha", x: 0, y: 0, width: 120, height: 40 }],
  edges: [],
};

const TWO_NODES = {
  nodes: [
    { id: "a", type: "text", text: "Alpha", x: 0, y: 0, width: 120, height: 40 },
    { id: "b", type: "text", text: "Beta", x: 200, y: 60, width: 120, height: 40 },
  ],
  edges: [{ id: "e", fromNode: "a", toNode: "b" }],
};

describe("Canvas embed live-refresh (#154)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Board.canvas"),
      JSON.stringify(ONE_NODE, null, "\t"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(vault.path, "Host.md"),
      "# Host\n\n![[Board]]\n",
      "utf-8",
    );
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openTreeFile(name: string): Promise<void> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`"${name}" not in tree`);
  }

  async function countNodesInActiveEmbed(): Promise<number> {
    return browser.execute(() => {
      const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
      const active = panes.find((el) => el.offsetParent !== null);
      if (!active) return -1;
      const embed = active.querySelector(".cm-embed-canvas");
      if (!embed) return 0;
      return embed.querySelectorAll(".vc-canvas-node").length;
    });
  }

  it("repaints the embed when the source .canvas is rewritten on disk", async () => {
    await openTreeFile("Host.md");

    // Initial paint — 1 node.
    await browser.waitUntil(async () => (await countNodesInActiveEmbed()) === 1, {
      timeout: 8000,
      timeoutMsg: "Initial embed never showed exactly 1 node",
    }).catch(async (err) => {
      const debug = await browser.execute(() => {
        const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
        const active = panes.find((el) => el.offsetParent !== null);
        return {
          hasPane: !!active,
          embedOuter: active?.querySelector(".cm-embed-canvas")?.outerHTML?.slice(0, 800) ?? null,
        };
      });
      throw new Error(`${err}; debug: ${JSON.stringify(debug)}`);
    });

    // Overwrite Board.canvas with a two-node version. The fs.watcher sees
    // this as an external write (no write_ignore suppression), dispatches
    // vault://file_change, and the embedPlugin should invalidate the
    // canvas cache + refresh the widget.
    fs.writeFileSync(
      path.join(vault.path, "Board.canvas"),
      JSON.stringify(TWO_NODES, null, "\t"),
      "utf-8",
    );

    await browser.waitUntil(async () => (await countNodesInActiveEmbed()) === 2, {
      timeout: 8000,
      timeoutMsg: "Embed did not refresh to 2 nodes after Board.canvas was rewritten",
    });
  });
});
