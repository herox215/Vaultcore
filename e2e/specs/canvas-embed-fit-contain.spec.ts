import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * E2E coverage for #158 — an embedded canvas must render *all* of its
 * nodes inside the embed viewport, never cropping at the max-height
 * edge. The old fit-to-width camera sized the body at 420 px but left
 * the world-transform width-driven, so tall canvases lost their
 * bottom nodes. The fit-contain camera (#158) scales the bbox to fit
 * both axes and centers horizontally when height is the limit.
 */

const TALL_CANVAS = {
  nodes: [
    { id: "top", type: "text", text: "TopNode", x: 0, y: 0, width: 100, height: 40 },
    { id: "bot", type: "text", text: "BottomNode", x: 0, y: 900, width: 100, height: 40 },
  ],
  edges: [],
};

describe("Canvas embed fit-contain (#158)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Tall.canvas"),
      JSON.stringify(TALL_CANVAS, null, "\t"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(vault.path, "Host.md"),
      "# Host\n\n![[Tall]]\n",
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

  it("renders both top and bottom nodes inside the embed's vertical bounds", async () => {
    await openTreeFile("Host.md");

    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
          const active = panes.find((el) => el.offsetParent !== null);
          if (!active) return 0;
          const embed = active.querySelector(".cm-embed-canvas");
          if (!embed) return 0;
          return embed.querySelectorAll(".vc-canvas-node").length;
        });
        return count === 2;
      },
      { timeout: 8000, timeoutMsg: "Embed did not render 2 canvas nodes" },
    );

    // The key assertion: every node's bounding rect must sit inside the
    // embed body's clip rect (within a 1px tolerance). With the old
    // fit-to-width camera the bottom node was cropped; with fit-contain
    // it scales down and stays visible.
    const result = await browser.execute(() => {
      const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
      const active = panes.find((el) => el.offsetParent !== null);
      if (!active) return { ok: false, reason: "no active pane" };
      const body = active.querySelector<HTMLElement>(".cm-embed-canvas-body");
      if (!body) return { ok: false, reason: "no embed body" };
      const bodyRect = body.getBoundingClientRect();
      const nodes = Array.from(
        body.querySelectorAll<HTMLElement>(".vc-canvas-node"),
      );
      const out: Array<{ id: string | null; top: number; bottom: number }> = [];
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        out.push({
          id: n.getAttribute("data-node-id"),
          top: r.top - bodyRect.top,
          bottom: r.bottom - bodyRect.top,
        });
      }
      const bodyHeight = bodyRect.height;
      const allInside = out.every((n) => n.top >= -1 && n.bottom <= bodyHeight + 1);
      return { ok: allInside, bodyHeight, nodes: out };
    });

    if (!result.ok) {
      throw new Error(
        `Nodes outside embed body: ${JSON.stringify(result)}`,
      );
    }
  });
});
