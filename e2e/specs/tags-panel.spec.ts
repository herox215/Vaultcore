import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textsOf } from "../helpers/text.js";

describe("Tags panel", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function activateTagsTab(): Promise<void> {
    const tab = await browser.$('[aria-label="Tags-Bereich"]');
    await tab.waitForDisplayed({ timeout: 3000 });
    await tab.click();
    await browser.$(".vc-tags-panel").waitForDisplayed({ timeout: 3000 });
  }

  it("shows tags extracted from the vault's notes", async () => {
    await activateTagsTab();

    // The fixture has #journal, #daily, #ideas, #brainstorm, #subfolder.
    // Extraction runs asynchronously off the indexer; TagRow renders the
    // display name with a leading '#' inside .vc-tag-name.
    await browser.waitUntil(
      async () => {
        const labels = await textsOf(await browser.$$(".vc-tag-name"));
        return labels.some((l) => l.toLowerCase().includes("ideas"));
      },
      { timeout: 8000, timeoutMsg: "Expected tag 'ideas' never appeared" },
    );

    const labels = await textsOf(await browser.$$(".vc-tag-name"));
    const flat = labels.map((l) => l.toLowerCase().replace(/^#/, ""));
    // At least one of the known fixture tags should be present.
    expect(
      flat.some((l) => ["journal", "daily", "ideas", "brainstorm", "subfolder"].includes(l)),
    ).toBe(true);
  });

  it("displays a count badge on each tag row", async () => {
    const counts = await browser.$$(".vc-tag-count");
    expect(counts.length).toBeGreaterThan(0);

    // Every visible count should parse to a positive integer — TagRow renders
    // the count as "(N)" so strip parentheses first.
    for (const c of counts) {
      const raw = ((await c.getProperty("textContent")) as string).trim();
      const digits = raw.replace(/[()\s]/g, "");
      const n = Number(digits);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it("drives a search when a tag is clicked", async () => {
    const rows = await browser.$$(".vc-tags-panel .vc-tag-label");
    // Click the first visible tag label.
    const target = rows[0];
    if (!target) throw new Error("No tag rows rendered to click");
    await target.click();

    // Clicking a tag switches the sidebar to the Search tab and populates the
    // input with "#tagname". Verify the input received a value.
    await browser.waitUntil(
      async () => {
        const input = await browser.$(".vc-search-input, [data-testid='search-input']");
        if (!(await input.isExisting())) return false;
        const v = (await input.getProperty("value")) as string;
        return typeof v === "string" && v.startsWith("#");
      },
      { timeout: 3000, timeoutMsg: "Search input was never populated with a #tag query" },
    );
  });
});
