import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

/**
 * #397 — mobile burger sheet e2e coverage.
 *
 * Resizes to 600x900 (matches #386 / #389 spec convention) so the
 * responsive @media branch fires and the burger sheet's parent gate
 * (`{#if isMobile}` in VaultLayout) is satisfied.
 *
 * Each test is self-contained — the afterEach drains burger + drawer
 * state with Escape so a failure produces a clean message rather than
 * a side-effect chain.
 */
describe("Mobile burger sheet (#397)", () => {
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

  async function isBurgerOpen(): Promise<boolean> {
    const sheets = await browser.$$(".vc-mobile-burger-sheet");
    return sheets.length > 0;
  }

  async function clickMoreTab(): Promise<void> {
    await browser.execute(() => {
      (document.getElementById("vc-mobile-tab-more") as HTMLElement | null)?.click();
    });
  }

  async function clickBurgerRow(rowId: string): Promise<void> {
    await browser.execute((id: string) => {
      const sel = `[data-row-id="${id}"]`;
      (document.querySelector(sel) as HTMLElement | null)?.click();
    }, rowId);
  }

  afterEach(async () => {
    // Drain any open sheet/menu/modal so each test starts clean.
    if (await isBurgerOpen()) {
      await browser.keys(["Escape"]); // panel view → menu, or menu → close
      await browser.keys(["Escape"]); // safety: close menu if still open
      await browser.waitUntil(async () => !(await isBurgerOpen()), { timeout: 3000 }).catch(() => {});
    }
  });

  it("More tab opens the burger sheet (menu view)", async () => {
    expect(await isBurgerOpen()).toBe(false);
    await clickMoreTab();
    await browser.waitUntil(isBurgerOpen, {
      timeout: 3000,
      timeoutMsg: "Burger sheet never opened after More tap",
    });
    const dialog = await browser.$('[role="dialog"][aria-label="More options"]');
    await dialog.waitForDisplayed({ timeout: 3000 });
    const rows = await browser.$$('[role="menuitem"]');
    expect(rows.length).toBe(6);
  });

  it("tapping the Backlinks row swaps the menu for the panel view", async () => {
    await clickMoreTab();
    await browser.waitUntil(isBurgerOpen, { timeout: 3000 });
    await clickBurgerRow("backlinks");
    const panelDialog = await browser.$('[role="dialog"][aria-label="Backlinks"]');
    await panelDialog.waitForDisplayed({ timeout: 3000 });
    // Menu role should be gone in the panel view.
    const menus = await browser.$$('[role="menu"]');
    expect(menus.length).toBe(0);
  });

  it("the back button returns to the menu view (does NOT close the sheet)", async () => {
    await clickMoreTab();
    await browser.waitUntil(isBurgerOpen, { timeout: 3000 });
    await clickBurgerRow("outline");
    await browser.$('[role="dialog"][aria-label="Gliederung"]').waitForDisplayed({ timeout: 3000 });
    await browser.execute(() => {
      (document.querySelector(".vc-mobile-burger-back") as HTMLElement | null)?.click();
    });
    await browser.$('[role="dialog"][aria-label="More options"]').waitForDisplayed({ timeout: 3000 });
    expect(await isBurgerOpen()).toBe(true);
  });

  it("scrim click closes the sheet", async () => {
    await clickMoreTab();
    await browser.waitUntil(isBurgerOpen, { timeout: 3000 });
    await browser.execute(() => {
      (document.querySelector(".vc-mobile-burger-scrim") as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => !(await isBurgerOpen()), {
      timeout: 3000,
      timeoutMsg: "Burger sheet never closed after scrim click",
    });
  });

  it("Escape from the menu view closes; Escape from the panel view returns to menu", async () => {
    // Menu view → Escape → close.
    await clickMoreTab();
    await browser.waitUntil(isBurgerOpen, { timeout: 3000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await isBurgerOpen()), { timeout: 3000 });

    // Panel view → Escape → menu (does not close).
    await clickMoreTab();
    await browser.waitUntil(isBurgerOpen, { timeout: 3000 });
    await clickBurgerRow("bookmarks");
    await browser.$('[role="dialog"][aria-label="Lesezeichen"]').waitForDisplayed({ timeout: 3000 });
    await browser.keys(["Escape"]);
    await browser.$('[role="dialog"][aria-label="More options"]').waitForDisplayed({ timeout: 3000 });
    expect(await isBurgerOpen()).toBe(true);
  });

  it("More tab closes the drawer if it was open before opening the burger", async () => {
    // Open the drawer via the Files tab, then tap More — the drawer
    // should close and the burger should open.
    await browser.execute(() => {
      (document.getElementById("vc-mobile-tab-files") as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => {
      const drawer = await browser.$(".vc-layout-sidebar");
      const cls = (await drawer.getAttribute("class")) ?? "";
      return cls.includes("vc-layout-sidebar--mobile-open");
    }, { timeout: 3000 });
    await clickMoreTab();
    await browser.waitUntil(isBurgerOpen, { timeout: 3000 });
    const drawer = await browser.$(".vc-layout-sidebar");
    const cls = (await drawer.getAttribute("class")) ?? "";
    expect(cls.includes("vc-layout-sidebar--mobile-open")).toBe(false);
  });
});
