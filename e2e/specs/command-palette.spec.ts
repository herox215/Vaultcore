import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Command palette", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openPalette(): Promise<WebdriverIO.Element> {
    await browser.keys(["Control", "p"]);
    const input = await browser.$('[data-testid="command-palette-input"]');
    await input.waitForDisplayed({ timeout: 3000 });
    return input;
  }

  async function closePalette(): Promise<void> {
    const backdrop = await browser.$('[data-testid="command-palette-backdrop"]');
    if (await backdrop.isDisplayed().catch(() => false)) {
      await browser.keys(["Escape"]);
      await backdrop.waitForDisplayed({ timeout: 2000, reverse: true });
    }
  }

  it("opens on Ctrl+P", async () => {
    const input = await openPalette();
    expect(await input.isDisplayed()).toBe(true);
    await closePalette();
  });

  it("filters commands by name", async () => {
    const input = await openPalette();
    await input.setValue("Lesezeichen");

    // Debounced render is synchronous via $derived, but give Svelte one tick.
    await browser.pause(100);

    const rows = await browser.$$('[data-testid="command-palette-row"]');
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const firstName = await textOf(rows[0]!);
    expect(firstName).toContain("Lesezeichen");

    await closePalette();
  });

  it("executes the selected command on Enter", async () => {
    const input = await openPalette();
    await input.setValue("Schnellwechsler");
    await browser.pause(100);
    await browser.keys(["Enter"]);

    // Palette closes, quick switcher opens.
    const backdrop = await browser.$('[data-testid="command-palette-backdrop"]');
    await backdrop.waitForDisplayed({ timeout: 2000, reverse: true });

    const qs = await browser.$(".vc-qs-input");
    await qs.waitForDisplayed({ timeout: 3000 });

    await browser.keys(["Escape"]);
    await qs.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("closes on Escape", async () => {
    await openPalette();
    const backdrop = await browser.$('[data-testid="command-palette-backdrop"]');
    await backdrop.waitForDisplayed({ timeout: 2000 });

    await browser.keys(["Escape"]);
    await backdrop.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("shows the empty state when nothing matches", async () => {
    const input = await openPalette();
    await input.setValue("zzzznomatchxyz");
    await browser.pause(100);

    const empty = await browser.$(".vc-cp-empty");
    await empty.waitForDisplayed({ timeout: 2000 });
    expect(await textOf(empty)).toContain("Keine");

    await closePalette();
  });

  it("navigates the result list with arrow keys", async () => {
    const input = await openPalette();
    // Empty query → MRU + rest, at least two rows.
    await browser.pause(100);

    const rowsBefore = await browser.$$('[data-testid="command-palette-row"]');
    expect(rowsBefore.length).toBeGreaterThanOrEqual(2);

    const initialSelectedId = await (
      await browser.$('[data-testid="command-palette-row"].vc-cp-row--selected')
    ).getAttribute("data-command-id");

    // Re-focus the input (ArrowDown must dispatch to the palette's keydown).
    await input.click();
    await browser.keys(["ArrowDown"]);
    await browser.pause(50);

    const nextSelectedId = await (
      await browser.$('[data-testid="command-palette-row"].vc-cp-row--selected')
    ).getAttribute("data-command-id");

    expect(nextSelectedId).not.toBe(initialSelectedId);

    await closePalette();
  });
});
