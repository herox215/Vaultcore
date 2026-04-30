import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

/**
 * #386 — mobile-shell e2e coverage.
 *
 * The layout collapses below 700px so we resize the WebKitWebDriver window
 * to 600x900 in `before` and restore the original size in `after`. tauri.conf
 * carries no minWidth/minHeight, so the resize succeeds.
 *
 * Pointer-event swipe gestures are NOT covered here — synthetic touch via
 * webdriver `performActions` is tauri-driver dependent and noisy. The vitest
 * spec covers the gesture logic; the swipe-to-open/close behaviour stays
 * manual UAT for this slice.
 */
describe("Mobile layout (#386)", () => {
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

  async function isDrawerOpen(): Promise<boolean> {
    const drawer = await browser.$(".vc-layout-sidebar");
    const cls = (await drawer.getAttribute("class")) ?? "";
    return cls.includes("vc-layout-sidebar--mobile-open");
  }

  it("hides the drawer on initial mobile load", async () => {
    expect(await isDrawerOpen()).toBe(false);
  });

  it("opens the drawer when the hamburger trigger is clicked", async () => {
    const trigger = await browser.$('button[aria-controls="vc-mobile-drawer"]');
    await trigger.waitForDisplayed({ timeout: 3000 });
    await browser.execute(() => {
      (document.querySelector('button[aria-controls="vc-mobile-drawer"]') as HTMLElement | null)?.click();
    });
    await browser.waitUntil(isDrawerOpen, {
      timeout: 3000,
      timeoutMsg: "Drawer never opened after hamburger click",
    });
  });

  it("closes the drawer when the scrim is clicked", async () => {
    expect(await isDrawerOpen()).toBe(true);
    await browser.execute(() => {
      (document.querySelector(".vc-mobile-scrim") as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => !(await isDrawerOpen()), {
      timeout: 3000,
      timeoutMsg: "Drawer never closed after scrim click",
    });
  });

  it("Escape closes an open drawer", async () => {
    await browser.execute(() => {
      (document.querySelector('button[aria-controls="vc-mobile-drawer"]') as HTMLElement | null)?.click();
    });
    await browser.waitUntil(isDrawerOpen, { timeout: 3000 });
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await isDrawerOpen()), {
      timeout: 3000,
      timeoutMsg: "Drawer never closed after Escape",
    });
  });

  it("removes the right sidebar / backlinks toggle from the DOM on mobile", async () => {
    const right = await browser.$$(".vc-layout-right-sidebar");
    expect(right.length).toBe(0);
    const backlinksBtn = await browser.$$(".vc-backlinks-toggle-btn");
    expect(backlinksBtn.length).toBe(0);
  });
});
