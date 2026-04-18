import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * E2E coverage for #148, ported to the OmniSearch UI introduced in #174.
 *
 * Pre-#174, the Suche panel had a manual "Index neu aufbauen" button and the
 * store auto-refetched the last query afterwards. OmniSearch replaces both:
 *   - FS changes flip `indexStale = true` via VaultLayout's watcher.
 *   - Opening the modal with a stale index kicks off `rebuild_index`
 *     automatically (no button) and the user re-runs their query against the
 *     fresh index without having to invoke anything.
 *
 * Scenario:
 *   1. Seed Alpha.md tagged #yoda. Run `#yoda` in content mode → 1 hit.
 *   2. Close modal. Write Beta.md (also #yoda) directly to disk.
 *   3. Re-open → auto-rebuild completes, query re-run → 2 hits.
 */
describe("OmniSearch auto-rebuild after FS change (#148, #174)", () => {
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

  async function openContentSearch(): Promise<WebdriverIO.Element> {
    await browser.keys(["Control", "Shift", "f"]);
    const modal = await browser.$(".vc-quick-switcher-modal");
    await modal.waitForDisplayed({ timeout: 3000 });
    const input = await browser.$(".vc-qs-input");
    await input.waitForDisplayed({ timeout: 3000 });
    return input;
  }

  async function closeOmni(): Promise<void> {
    await browser.keys(["Escape"]);
    const modal = await browser.$(".vc-quick-switcher-modal");
    await modal.waitForDisplayed({ timeout: 2000, reverse: true });
  }

  async function typeQuery(input: WebdriverIO.Element, q: string): Promise<void> {
    await input.click();
    await input.setValue(q);
    await browser.pause(400);
  }

  async function resultFilenames(): Promise<string[]> {
    const rows = await browser.$$(".vc-search-result-row");
    const names: string[] = [];
    for (const r of rows) {
      const n = await r.$(".vc-search-result-filename");
      names.push(await textOf(n));
    }
    return names;
  }

  it("auto-rebuilds on re-open after a file is added and finds the new hit", async () => {
    // 1. First pass — only Alpha exists.
    let input = await openContentSearch();
    await typeQuery(input, "#yoda");

    await browser.waitUntil(
      async () => (await browser.$$(".vc-search-result-row")).length >= 1,
      { timeout: 3000, timeoutMsg: "Initial #yoda search returned no hits" },
    );
    const initialNames = await resultFilenames();
    expect(initialNames.some((n) => n.includes("Alpha"))).toBe(true);
    expect(initialNames.some((n) => n.includes("Beta"))).toBe(false);

    await closeOmni();

    // 2. Add Beta.md on disk. The watcher flips indexStale = true in the
    //    store. The next OmniSearch open triggers the auto-rebuild.
    fs.writeFileSync(path.join(vault.path, "Beta.md"), "# Beta\n\n#yoda\n", "utf-8");
    await browser.pause(500);

    // 3. Re-open — auto-rebuild must run, then we re-type the query and
    //    both notes should appear. Wait for the transient rebuild status
    //    line to clear before asserting on results.
    input = await openContentSearch();

    await browser.waitUntil(
      async () => {
        const statusEl = await browser.$(".vc-omni-status");
        const displayed = await statusEl.isDisplayed().catch(() => false);
        return !displayed;
      },
      { timeout: 15000, timeoutMsg: "Rebuild status never cleared" },
    );

    await typeQuery(input, "#yoda");

    await browser.waitUntil(
      async () => {
        const names = await resultFilenames();
        return (
          names.some((n) => n.includes("Alpha")) &&
          names.some((n) => n.includes("Beta"))
        );
      },
      {
        timeout: 8000,
        timeoutMsg: "Results never updated to include Alpha + Beta after auto-rebuild",
      },
    );

    await closeOmni();
  });
});
