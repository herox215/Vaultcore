import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * E2E coverage for #147 — wiki-links and embeds must resolve `.canvas` the
 * same way they resolve `.md`. We seed a small canvas and a note that both
 * links to it (`[[Board]]`) and embeds it (`![[Board]]`), then:
 *   - click the wiki-link → a CanvasView opens in a tab.
 *   - assert the embed widget paints an SVG preview (rect per node) in the
 *     active `.cm-content`.
 */

const BOARD_CANVAS = {
  nodes: [
    { id: "a", type: "text", text: "Alpha", x: 0, y: 0, width: 120, height: 40 },
    { id: "b", type: "text", text: "Beta", x: 200, y: 80, width: 120, height: 40 },
  ],
  edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
};

describe("Canvas wiki-links & embeds (#147)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(
      path.join(vault.path, "Board.canvas"),
      JSON.stringify(BOARD_CANVAS, null, "\t"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(vault.path, "Linker.md"),
      [
        "# Linker",
        "",
        "A link to the canvas: [[Board]]",
        "",
        "And an embed of it:",
        "",
        "![[Board]]",
        "",
      ].join("\n"),
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

  it("renders a canvas embed SVG preview inside the active editor", async () => {
    await openTreeFile("Linker.md");

    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000, timeoutMsg: "Editor never displayed for Linker.md" },
    );

    await browser.waitUntil(
      async () => {
        const found = await browser.execute(() => {
          const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
          const active = panes.find((el) => el.offsetParent !== null);
          if (!active) return false;
          const svg = active.querySelector(".cm-embed-canvas svg");
          if (!svg) return false;
          return svg.querySelectorAll("rect").length >= 2;
        });
        return found;
      },
      { timeout: 8000, timeoutMsg: "Canvas embed SVG with >=2 rects never rendered" },
    );
  });

  it("opens a canvas tab when the [[Board]] wiki-link is clicked", async () => {
    await browser.execute(() => {
      const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
      const active = panes.find((el) => el.offsetParent !== null);
      if (!active) throw new Error("no active editor");
      const link = active.querySelector<HTMLElement>(".cm-wikilink-resolved");
      if (!link) throw new Error("no .cm-wikilink-resolved in active editor");
      // wikiLink.ts listens for `mousedown`, not `click`.
      link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });

    await browser.waitUntil(
      async () => {
        const vps = await browser.$$(".vc-canvas-viewport");
        for (const vp of vps) if (await vp.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000, timeoutMsg: "Canvas viewport never became visible after link click" },
    );

    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await browser.waitUntil(
      async () => ((await activeLabel.getProperty("textContent")) as string).includes("Board"),
      { timeout: 3000, timeoutMsg: "Active tab never switched to Board" },
    );
  });
});
