import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

// LocalGraphPanel.svelte exists but is not mounted anywhere in the current
// UI (see #32 — the right sidebar has Properties/Outline/Outgoing/Backlinks
// only, no Local Graph subtab). Re-enable once the panel is wired in.
describe.skip("Local Graph panel", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
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

  async function activateLocalGraphSubtab(): Promise<void> {
    await browser.execute(() => {
      const btn = document.querySelector('[aria-label="Local Graph"][role="tab"]') as HTMLElement | null;
      btn?.click();
    });
    await browser.$('[aria-label="Local Graph"][role="complementary"]').waitForDisplayed({ timeout: 3000 });
  }

  it("renders the local graph canvas for a note with neighbors", async () => {
    await openTreeFile("Welcome.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );
    await ensureRightSidebar();
    await activateLocalGraphSubtab();

    const canvas = await browser.$(".vc-graph-canvas");
    await canvas.waitForDisplayed({ timeout: 3000 });

    // A sigma <canvas> element should mount inside the container once the
    // backend returns the local-graph payload.
    await browser.waitUntil(
      async () => {
        const has = await browser.execute(
          () => document.querySelector(".vc-graph-canvas canvas") !== null,
        );
        return has;
      },
      { timeout: 5000, timeoutMsg: "Sigma canvas never mounted" },
    );
  });

  it("shows the no-links overlay for a note with no outgoing or incoming links", async () => {
    await openTreeFile("subfolder");
    await openTreeFile("Another Note.md");
    // Ensure the panel picks up the new active note (debounced 200ms).
    await browser.pause(400);

    // Either an empty-state or a no-links overlay should appear. Both are
    // acceptable — the panel renders one or the other depending on whether
    // the backend returned an empty neighborhood or a 1-node graph.
    await browser.waitUntil(
      async () => {
        const empty = await browser.$$(".vc-graph-empty");
        const noLinks = await browser.$$(".vc-graph-no-links");
        return (empty.length > 0 && (await empty[0]!.isDisplayed()))
          || (noLinks.length > 0 && (await noLinks[0]!.isDisplayed()));
      },
      { timeout: 3000, timeoutMsg: "Neither empty nor no-links state appeared for Another Note.md" },
    );
  });

  it("collapses and expands the panel when the header is clicked", async () => {
    const header = await browser.$(".vc-graph-header");
    await header.click();

    await browser.waitUntil(
      async () => (await header.getAttribute("aria-expanded")) === "false",
      { timeout: 2000, timeoutMsg: "Graph header never collapsed" },
    );

    await header.click();
    await browser.waitUntil(
      async () => (await header.getAttribute("aria-expanded")) === "true",
      { timeout: 2000, timeoutMsg: "Graph header never expanded again" },
    );
  });
});
