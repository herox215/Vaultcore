import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textsOf } from "../helpers/text.js";

/**
 * The actual save-to-disk step opens a native Tauri file picker that
 * WebDriver cannot dismiss — so we verify the two commands are registered
 * and reachable through the command palette, not the file write itself.
 * That's the check this spec can meaningfully perform end-to-end without
 * hanging on the native dialog.
 */
describe("Export HTML / PDF", () => {
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
    await browser.keys(["Escape"]);
    const backdrop = await browser.$('[data-testid="command-palette-backdrop"]');
    await backdrop.waitForDisplayed({ timeout: 2000, reverse: true });
  }

  it("lists the HTML export command in the palette", async () => {
    const input = await openPalette();
    await input.setValue("HTML");
    await browser.pause(100);

    const rows = await browser.$$('[data-testid="command-palette-row"]');
    const names = await textsOf(rows);
    expect(names.some((n) => n.toLowerCase().includes("html"))).toBe(true);

    await closePalette();
  });

  it("lists the PDF export command in the palette", async () => {
    const input = await openPalette();
    await input.setValue("PDF");
    await browser.pause(100);

    const rows = await browser.$$('[data-testid="command-palette-row"]');
    const names = await textsOf(rows);
    expect(names.some((n) => n.toLowerCase().includes("pdf"))).toBe(true);

    await closePalette();
  });
});
