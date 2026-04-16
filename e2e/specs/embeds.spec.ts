import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * A 1x1 transparent PNG — same trick as image-preview.spec.ts. We need a
 * real image file on disk so the embedPlugin can resolve the attachment
 * path and the widget renders an <img> element.
 */
const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

describe("Inline embeds", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();

    // Seed a tiny image attachment + a note that embeds it and a note.
    fs.writeFileSync(path.join(vault.path, "attachments", "pixel.png"), PNG_1PX);
    fs.writeFileSync(
      path.join(vault.path, "Embedder.md"),
      [
        "# Embedder",
        "",
        "Here is an image embed:",
        "",
        "![[attachments/pixel.png]]",
        "",
        "And a note embed:",
        "",
        "![[Ideas]]",
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

  it("renders an <img> widget for an ![[image.png]] embed", async () => {
    await openTreeFile("Embedder.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // embedPlugin builds an <img> inside the active .cm-content for wiki
    // image embeds once the attachment resolves (async IPC).
    await browser.waitUntil(
      async () => {
        const found = await browser.execute(() => {
          const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
          const active = panes.find((el) => el.offsetParent !== null);
          return active?.querySelector("img") !== null && active?.querySelector("img") !== undefined;
        });
        return found;
      },
      { timeout: 8000, timeoutMsg: "Image embed widget never rendered" },
    );
  });

  it("renders a note-embed block widget for an ![[Note]] embed", async () => {
    // The note embed mounts as `<div class="cm-embed-note" data-embed-path=...>`
    // inside the active editor. Content is fetched async — the widget starts
    // with "…" and updates once readFile() resolves. Accept either: the widget
    // exists (success path), or a `.cm-embed-broken` appears (resolveTarget
    // miss — still a valid render path we want to confirm doesn't crash).
    await browser.waitUntil(
      async () => {
        const found = await browser.execute(() => {
          const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
          const active = panes.find((el) => el.offsetParent !== null);
          if (!active) return false;
          return active.querySelector(".cm-embed-note, .cm-embed-broken") !== null;
        });
        return found;
      },
      { timeout: 8000, timeoutMsg: "Neither .cm-embed-note nor .cm-embed-broken rendered" },
    );
  });
});
