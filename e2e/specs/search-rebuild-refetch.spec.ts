import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * E2E coverage for #148 — after "Index neu aufbauen" in the Suche panel,
 * the results list must be recomputed against the fresh index. Without
 * this, newly-indexed files only appear once the user edits the query.
 *
 * Scenario:
 *   1. Seed a vault with Alpha.md tagged #yoda.
 *   2. Run `#yoda` → 1 result.
 *   3. Write Beta.md (also tagged #yoda) directly to disk.
 *   4. Click rebuild → result list grows to 2 without query edit.
 */

describe("Search re-runs after rebuild (#148)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(path.join(vault.path, "Alpha.md"), "# Alpha\n\n#yoda\n", "utf-8");
    await openVaultInApp(vault.path);
    await browser.pause(1500); // initial indexing
  });

  after(() => {
    vault.cleanup();
  });

  async function ensureSearchTabActive(): Promise<WebdriverIO.Element> {
    await browser.keys(["Control", "Shift", "f"]);
    const panel = await browser.$(".vc-search-panel");
    await panel.waitForDisplayed({ timeout: 3000 });
    const input = await browser.$(".vc-search-input");
    await input.waitForDisplayed({ timeout: 3000 });
    return input;
  }

  async function typeQuery(input: WebdriverIO.Element, q: string): Promise<void> {
    await input.click();
    await input.setValue(q);
    await browser.pause(400);
  }

  it("refreshes the results list after a rebuild without editing the query", async () => {
    const input = await ensureSearchTabActive();
    await typeQuery(input, "#yoda");

    await browser.waitUntil(
      async () => (await browser.$$(".vc-search-result-row")).length >= 1,
      { timeout: 3000, timeoutMsg: "Initial #yoda search returned no hits" },
    );
    const initialRows = await browser.$$(".vc-search-result-row");
    const initialNames: string[] = [];
    for (const r of initialRows) {
      const n = await r.$(".vc-search-result-filename");
      initialNames.push(await textOf(n));
    }
    expect(initialNames.some((n) => n.includes("Alpha"))).toBe(true);
    expect(initialNames.some((n) => n.includes("Beta"))).toBe(false);

    // Add a second #yoda note on disk. The watcher flips indexStale = true
    // but won't auto-rebuild — that's the manual rebuild this test exercises.
    fs.writeFileSync(path.join(vault.path, "Beta.md"), "# Beta\n\n#yoda\n", "utf-8");
    await browser.pause(500);

    // Click rebuild.
    const rebuildBtn = await browser.$('button[aria-label="Index neu aufbauen"]');
    await rebuildBtn.click();

    // Wait for rebuild to finish (button re-enables) and refetch to populate.
    await browser.waitUntil(
      async () => {
        const ariaDisabled = await rebuildBtn.getAttribute("aria-disabled");
        return ariaDisabled !== "true";
      },
      { timeout: 15000, timeoutMsg: "Rebuild never finished" },
    );

    await browser.waitUntil(
      async () => {
        const rows = await browser.$$(".vc-search-result-row");
        const names: string[] = [];
        for (const r of rows) {
          const n = await r.$(".vc-search-result-filename");
          names.push(await textOf(n));
        }
        return names.some((n) => n.includes("Alpha")) && names.some((n) => n.includes("Beta"));
      },
      {
        timeout: 8000,
        timeoutMsg: "Results never updated to include both Alpha.md and Beta.md after rebuild",
      },
    );
  });
});
