import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * Tree drag-and-drop is implemented via native HTML5 drag events plus a
 * custom MIME type `text/vaultcore-file`. Real WebDriver drag sequences are
 * unreliable across WebKit — we dispatch the dragstart → dragover → drop
 * events programmatically, which exercises the same handlers the user flow
 * triggers.
 */
// The tree's drag handlers read `e.dataTransfer.getData("text/vaultcore-file")`.
// Synthetic `new DragEvent(..., { dataTransfer })` is readonly in WebKit, so
// `setData` calls from `ondragstart` never persist into the `drop` event.
// WebDriver Actions API drag-sequences are also unreliable across the Tauri
// WebKit driver. Component-level DnD coverage lives in TreeNode unit tests;
// re-enable this spec once we route DnD through an e2e-only store hook.
describe.skip("Tree drag-and-drop", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();

    // Seed an extra target folder with NO backlinks-casacde requirement so
    // the drop completes without a confirmation dialog.
    fs.mkdirSync(path.join(vault.path, "archive"), { recursive: true });

    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function findTreeNode(name: string): Promise<WebdriverIO.Element> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) return n;
    }
    throw new Error(`"${name}" not in tree`);
  }

  async function expandFolder(name: string): Promise<void> {
    const node = await findTreeNode(name);
    await node.click();
  }

  it("moves a file into a folder when dropped on it", async () => {
    // Wiki Links.md has no inbound links, so move will not trigger the
    // backlinks cascade confirmation dialog.
    const source = await findTreeNode("Wiki Links.md");
    const target = await findTreeNode("archive");

    await browser.execute(
      (src: HTMLElement, tgt: HTMLElement) => {
        const dt = new DataTransfer();
        dt.effectAllowed = "move";
        // The codebase reads/writes `text/vaultcore-file` with the source
        // relative path. The tree node also knows its own path via a data
        // attribute on its container; if that attribute is missing, use the
        // node's text as a fallback marker — the onDrop handler looks up the
        // source via the treeDrag store set by dragstart.
        src.dispatchEvent(new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }));
        tgt.dispatchEvent(new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }));
        tgt.dispatchEvent(new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }));
        src.dispatchEvent(new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }));
      },
      source,
      target,
    );

    // Open the archive folder and verify the moved file is there.
    await browser.pause(400);
    await expandFolder("archive");

    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes("Wiki Links.md");
      },
      { timeout: 3000, timeoutMsg: "Wiki Links.md never appeared under archive/" },
    );
  });
});
