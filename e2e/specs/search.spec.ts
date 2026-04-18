import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

// #174 — the standalone "Suche" sidebar panel was replaced by the unified
// OmniSearch modal. Ctrl+Shift+F now opens OmniSearch in content mode; this
// spec covers the same full-text search contract against the new shell.
describe("Full-text search (OmniSearch content mode)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
    // Give Tantivy a moment to finish the initial index build.
    await browser.pause(1500);
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
    // Must already be in content mode because Ctrl+Shift+F is bound to that.
    const contentTab = await browser.$('[data-omni-mode="content"]');
    expect(await contentTab.getAttribute("aria-pressed")).toBe("true");
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
    // OmniSearch debounces at ~200ms; wait for results to render.
    await browser.pause(400);
  }

  it("opens the OmniSearch modal in content mode on Ctrl+Shift+F", async () => {
    const input = await openContentSearch();
    expect(await input.isDisplayed()).toBe(true);
    await closeOmni();
  });

  it("returns matching results for a known term", async () => {
    const input = await openContentSearch();
    await typeQuery(input, "Ideas");

    const rows = await browser.$$(".vc-search-result-row");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const filenames: string[] = [];
    for (const row of rows) {
      const nameEl = await row.$(".vc-search-result-filename");
      filenames.push(await textOf(nameEl));
    }
    expect(filenames.some((f) => f.includes("Ideas"))).toBe(true);
    await closeOmni();
  });

  it("shows the empty state when nothing matches", async () => {
    const input = await openContentSearch();
    await typeQuery(input, "zzzzqqqnomatch");

    const empty = await browser.$(".vc-qs-empty");
    await empty.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(empty)).toContain("Keine");
    await closeOmni();
  });

  it("resets to the empty prompt when the query is cleared", async () => {
    const input = await openContentSearch();
    await typeQuery(input, "Ideas");

    // Clear the query via a direct input dispatch — WebKit rejects
    // elementClear on some inputs with "Missing text parameter", and the
    // handler runs the same code path either way.
    await browser.execute(() => {
      const el = document.querySelector(".vc-qs-input") as
        | HTMLInputElement
        | null;
      if (!el) return;
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.pause(400);

    const rows = await browser.$$(".vc-search-result-row");
    expect(rows.length).toBe(0);

    // Content mode shows a hint in the empty state when no query is set.
    const empty = await browser.$(".vc-qs-empty");
    await empty.waitForDisplayed({ timeout: 2000 });
    expect(await textOf(empty)).toContain("Tippe");
    await closeOmni();
  });
});
