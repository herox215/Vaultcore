import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

/**
 * #394 — mobile settings sheet e2e coverage.
 *
 * Resizes to 600x900 (matches #386 / #389 / #397 spec convention) so the
 * VaultLayout `{#if isMobile}` branch fires and renders MobileSettingsSheet
 * instead of the desktop SettingsModal.
 *
 * Each test is self-contained — afterEach drains sheet state with Escape
 * presses so a failure produces a clean message rather than a side-effect
 * chain.
 */
describe("Mobile settings sheet (#394)", () => {
  let vault: TestVault;
  let restoreSize: { width: number; height: number } | null = null;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
    restoreSize = await browser.getWindowSize();
    await browser.setWindowSize(600, 900);
  });

  after(async () => {
    if (restoreSize) {
      await browser.setWindowSize(restoreSize.width, restoreSize.height);
    }
    vault.cleanup();
  });

  async function isSheetOpen(): Promise<boolean> {
    const sheets = await browser.$$(".vc-mobile-settings-sheet");
    return sheets.length > 0;
  }

  async function clickGearIcon(): Promise<void> {
    await browser.execute(() => {
      // The gear icon's only stable selector is its aria-label.
      const btn = document.querySelector('button[aria-label="Einstellungen"]') as HTMLElement | null;
      btn?.click();
    });
  }

  async function clickRow(rowId: string): Promise<void> {
    await browser.execute((id: string) => {
      (document.querySelector(`[data-row-id="${id}"]`) as HTMLElement | null)?.click();
    }, rowId);
  }

  afterEach(async () => {
    if (await isSheetOpen()) {
      await browser.keys(["Escape"]); // detail → master, or master → close
      await browser.keys(["Escape"]); // safety: ensure close
      // No .catch() — let cleanup failures propagate. If a test leaves
      // the sheet stuck open, that's a real bug worth seeing rather
      // than silently swallowing.
      await browser.waitUntil(async () => !(await isSheetOpen()), { timeout: 3000 });
    }
  });

  it("topbar gear renders the mobile sheet (NOT the desktop modal)", async () => {
    expect(await isSheetOpen()).toBe(false);
    await clickGearIcon();
    await browser.waitUntil(isSheetOpen, {
      timeout: 3000,
      timeoutMsg: "Mobile settings sheet never opened after gear click",
    });
    // Verify the desktop modal is NOT in the DOM.
    const desktopModal = await browser.$$('[data-testid="settings-modal"]');
    expect(desktopModal.length).toBe(0);
  });

  it("master view renders 5 category rows", async () => {
    await clickGearIcon();
    await browser.waitUntil(isSheetOpen, { timeout: 3000 });
    const rows = await browser.$$('[role="menuitem"]');
    expect(rows.length).toBe(5);
  });

  it("Erscheinungsbild detail → theme change → back persists store state", async () => {
    await clickGearIcon();
    await browser.waitUntil(isSheetOpen, { timeout: 3000 });
    await clickRow("appearance");
    // Pick the dark radio and check the document attribute.
    await browser.execute(() => {
      const r = document.querySelector('input[type="radio"][value="dark"]') as HTMLInputElement | null;
      if (r) {
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await browser.waitUntil(async () => {
      return await browser.execute(() => document.documentElement.dataset.theme === "dark");
    }, { timeout: 3000, timeoutMsg: "Theme attribute never reflected dark choice" });

    // Back → master view.
    await browser.execute(() => {
      (document.querySelector(".vc-mobile-settings-back") as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => (await browser.$$('[role="menu"]')).length > 0, {
      timeout: 3000,
      timeoutMsg: "Back never returned to master view",
    });
  });

  it("X close button closes the sheet from master view", async () => {
    await clickGearIcon();
    await browser.waitUntil(isSheetOpen, { timeout: 3000 });
    await browser.execute(() => {
      (document.querySelector(".vc-mobile-settings-close") as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => !(await isSheetOpen()), {
      timeout: 3000,
      timeoutMsg: "Sheet never closed after X click",
    });
  });

  it("Escape closes from master view; Escape from detail view returns to master", async () => {
    await clickGearIcon();
    await browser.waitUntil(isSheetOpen, { timeout: 3000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await isSheetOpen()), { timeout: 3000 });

    await clickGearIcon();
    await browser.waitUntil(isSheetOpen, { timeout: 3000 });
    await clickRow("fonts");
    await browser.waitUntil(async () => (await browser.$$('[role="menu"]')).length === 0, { timeout: 3000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => (await browser.$$('[role="menu"]')).length > 0, {
      timeout: 3000,
      timeoutMsg: "Escape from detail view never returned to master",
    });
    expect(await isSheetOpen()).toBe(true);
  });

  it("burger sheet → Einstellungen row opens the same mobile settings sheet", async () => {
    // Open burger via More tab.
    await browser.execute(() => {
      (document.getElementById("vc-mobile-tab-more") as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => (await browser.$$(".vc-mobile-burger-sheet")).length > 0, {
      timeout: 3000,
    });
    // Click Einstellungen row.
    await browser.execute(() => {
      (document.querySelector('[data-row-id="settings"]') as HTMLElement | null)?.click();
    });
    await browser.waitUntil(isSheetOpen, {
      timeout: 3000,
      timeoutMsg: "Mobile settings sheet never opened from burger row",
    });
    // The burger sheet itself should have closed.
    const burgers = await browser.$$(".vc-mobile-burger-sheet");
    expect(burgers.length).toBe(0);
  });
});
