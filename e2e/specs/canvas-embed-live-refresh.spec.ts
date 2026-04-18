// #165 — markdown previews inside canvas file-nodes must live-refresh when
// the embedded note changes. This spec exercises the external-watcher path:
// we seed a canvas with a file-node pointing at `Notes/foo.md`, open the
// canvas, then rewrite `foo.md` from the test process (which the Rust file
// watcher sees as an external modification since write_ignore only
// suppresses VaultCore's own IPC writes). Within a few seconds the preview
// inside `.vc-canvas-node-md` must update without the canvas being closed.

import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

const CANVAS_NAME = "Board.canvas";
const NOTE_REL = "Notes/foo.md";

const INITIAL_NOTE = "# Version One\n\nInitial body text.";
const UPDATED_NOTE = "# Version Two\n\nBody after external edit.";

describe("Canvas embed live-refresh (#165)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.mkdirSync(path.join(vault.path, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(vault.path, NOTE_REL), INITIAL_NOTE, "utf-8");
    fs.writeFileSync(
      path.join(vault.path, CANVAS_NAME),
      JSON.stringify(
        {
          nodes: [
            {
              id: "fn",
              type: "file",
              file: NOTE_REL,
              x: 0,
              y: 0,
              width: 320,
              height: 200,
            },
          ],
          edges: [],
        },
        null,
        "\t",
      ),
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

  async function previewContains(substr: string): Promise<boolean> {
    return browser.execute(
      (needle: string) => {
        const md = document.querySelector(".vc-canvas-node-md");
        if (!md) return false;
        return (md.textContent ?? "").includes(needle);
      },
      substr,
    );
  }

  it("re-renders the embedded note preview when the source file changes externally", async () => {
    await openTreeFile(CANVAS_NAME);

    // Wait for the canvas to mount and the initial preview to render.
    await browser.waitUntil(async () => previewContains("Version One"), {
      timeout: 5000,
      timeoutMsg: "Initial preview never rendered",
    });

    // External modification — the watcher picks this up because the test
    // process bypasses the app's IPC write path.
    fs.writeFileSync(path.join(vault.path, NOTE_REL), UPDATED_NOTE, "utf-8");

    await browser.waitUntil(async () => previewContains("Version Two"), {
      timeout: 5000,
      timeoutMsg: "Preview never refreshed to updated body",
    });

    // Sanity: the old content is gone too.
    expect(await previewContains("Version One")).toBe(false);
  });
});
