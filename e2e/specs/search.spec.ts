import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Full-text search", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
    // Give Tantivy a moment to finish the initial index build so queries
    // against the fixture content return hits.
    await browser.pause(1500);
  });

  after(() => {
    vault.cleanup();
  });

  async function ensureSearchTabActive(): Promise<WebdriverIO.Element> {
    // Ctrl+Shift+F activates the Suche tab via the registered command.
    await browser.keys(["Control", "Shift", "f"]);
    const panel = await browser.$(".vc-search-panel");
    await panel.waitForDisplayed({ timeout: 3000 });
    const input = await browser.$(".vc-search-input");
    await input.waitForDisplayed({ timeout: 3000 });
    return input;
  }

  async function typeQuery(input: WebdriverIO.Element, q: string): Promise<void> {
    await input.click();
    // Clear any previous value before setting a new one.
    await input.setValue(q);
    // SearchInput debounces at ~200ms; wait for results to render.
    await browser.pause(400);
  }

  it("activates the search tab via Ctrl+Shift+F", async () => {
    const input = await ensureSearchTabActive();
    expect(await input.isDisplayed()).toBe(true);
  });

  it("returns matching results for a known term", async () => {
    const input = await ensureSearchTabActive();
    await typeQuery(input, "Ideas");

    const rows = await browser.$$(".vc-search-result-row");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const filenames: string[] = [];
    for (const row of rows) {
      const nameEl = await row.$(".vc-search-result-filename");
      filenames.push(await textOf(nameEl));
    }
    expect(filenames.some((f) => f.includes("Ideas"))).toBe(true);
  });

  it("shows the empty state when nothing matches", async () => {
    const input = await ensureSearchTabActive();
    await typeQuery(input, "zzzzqqqnomatch");

    const empty = await browser.$(".vc-search-results-empty");
    await empty.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(empty)).toContain("Keine");
  });

  it("clears results when the query is emptied", async () => {
    const input = await ensureSearchTabActive();
    await typeQuery(input, "Ideas");

    // Clear the query — SearchPanel short-circuits to clearResults() when
    // trim() is empty and renders nothing below the input. WebKitWebDriver
    // rejects elementClear on some inputs ("Missing text parameter"), so we
    // dispatch an `input` event with value="" directly through the DOM —
    // SearchInput's oninput handler runs the same code path either way.
    await browser.execute(() => {
      const el = document.querySelector(".vc-search-input") as HTMLInputElement | null;
      if (!el) return;
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.pause(400);

    const rows = await browser.$$(".vc-search-result-row");
    expect(rows.length).toBe(0);

    const empty = await browser.$$(".vc-search-results-empty");
    expect(empty.length).toBe(0);
  });
});
