import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Outline panel", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();

    // Add a note with multiple headings so the outline has something to render.
    fs.writeFileSync(
      path.join(vault.path, "Outlined.md"),
      [
        "# Top heading",
        "",
        "Intro paragraph.",
        "",
        "## Section A",
        "",
        "Text.",
        "",
        "## Section B",
        "",
        "### Subsection B1",
        "",
        "More text.",
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

  async function ensureRightSidebar(): Promise<void> {
    const wrappers = await browser.$$(".vc-layout-right-sidebar");
    const cls = (await wrappers[0]!.getAttribute("class")) ?? "";
    if (cls.includes("vc-layout-right-sidebar--hidden")) {
      await browser.keys(["Control", "Shift", "b"]);
      await browser.waitUntil(
        async () => {
          const c = (await wrappers[0]!.getAttribute("class")) ?? "";
          return !c.includes("vc-layout-right-sidebar--hidden");
        },
        { timeout: 2000 },
      );
    }
  }

  async function activateOutlineSubtab(): Promise<void> {
    await browser.execute(() => {
      const btn = document.querySelector('[aria-label="Outline"][role="tab"]') as HTMLElement | null;
      btn?.click();
    });
    await browser.$(".vc-outline-panel").waitForDisplayed({ timeout: 3000 });
  }

  it("renders every heading from the active document", async () => {
    await openTreeFile("Outlined.md");
    await browser.$(".cm-content").waitForDisplayed({ timeout: 5000 });
    await ensureRightSidebar();
    await activateOutlineSubtab();

    await browser.waitUntil(
      async () => {
        const items = await browser.$$(".vc-outline-panel [role=\"listitem\"]");
        return items.length >= 4;
      },
      { timeout: 3000, timeoutMsg: "Outline never showed 4 headings" },
    );

    const items = await browser.$$(".vc-outline-panel [role=\"listitem\"]");
    const texts = await textsOf(items);
    expect(texts.some((t) => t.includes("Top heading"))).toBe(true);
    expect(texts.some((t) => t.includes("Section A"))).toBe(true);
    expect(texts.some((t) => t.includes("Subsection B1"))).toBe(true);
  });

  it("shows the heading count badge", async () => {
    const count = await browser.$(".vc-outline-count");
    await count.waitForDisplayed({ timeout: 3000 });
    const n = Number((await textOf(count)).trim());
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it("collapses and expands the panel when the header is clicked", async () => {
    const header = await browser.$(".vc-outline-header");
    await header.click();

    await browser.waitUntil(
      async () => (await header.getAttribute("aria-expanded")) === "false",
      { timeout: 2000, timeoutMsg: "Outline header never collapsed" },
    );

    await header.click();
    await browser.waitUntil(
      async () => (await header.getAttribute("aria-expanded")) === "true",
      { timeout: 2000, timeoutMsg: "Outline header never expanded again" },
    );
  });
});
