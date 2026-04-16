import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * A 1x1 transparent PNG — smallest legal image. Hard-coded so the spec
 * doesn't depend on any fixture file or image-decoding library.
 */
const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

describe("Image preview", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();

    // Drop a PNG into the pre-existing attachments folder so the tree picks it up.
    const imgPath = path.join(vault.path, "attachments", "dot.png");
    fs.writeFileSync(imgPath, PNG_1PX);

    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function expandFolder(name: string): Promise<void> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`Folder "${name}" not in tree`);
  }

  async function clickTreeFile(name: string): Promise<void> {
    // Ensure the target appears (folder may need expanding first) and click it.
    await browser.waitUntil(
      async () => {
        const nodes = await browser.$$(".vc-tree-name");
        const names = await textsOf(nodes);
        return names.includes(name);
      },
      { timeout: 3000, timeoutMsg: `"${name}" never appeared in the tree` },
    );

    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
  }

  it("renders an image tab when a .png file is clicked", async () => {
    await expandFolder("attachments");
    await clickTreeFile("dot.png");

    const img = await browser.$(".vc-image-preview-img");
    await img.waitForDisplayed({ timeout: 5000 });

    const alt = (await img.getProperty("alt")) as string;
    expect(alt).toContain("dot.png");

    const src = (await img.getProperty("src")) as string;
    expect(typeof src === "string" && src.length > 0).toBe(true);
  });

  it("labels the tab with the image filename", async () => {
    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 3000 });
    const text = (await activeLabel.getProperty("textContent")) as string;
    expect(text).toBe("dot.png");
  });
});
