import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

/**
 * #389 — bottom-tab-bar e2e coverage.
 *
 * Resizes the WebKitWebDriver window to 600x900 (matches the #386 spec
 * convention) so the responsive @media (max-width: 699px) branch fires
 * and the tab bar mounts.
 *
 * Each test is self-contained — no test depends on the side effects of
 * the one before it. afterEach closes the drawer if any test left it open.
 */
describe("Mobile bottom tab bar (#389)", () => {
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

  async function clickFilesTab(): Promise<void> {
    await browser.execute(() => {
      (document.getElementById("vc-mobile-tab-files") as HTMLElement | null)?.click();
    });
  }

  async function clickSearchTab(): Promise<void> {
    await browser.execute(() => {
      (document.getElementById("vc-mobile-tab-search") as HTMLElement | null)?.click();
    });
  }

  async function clickMoreTab(): Promise<void> {
    await browser.execute(() => {
      (document.getElementById("vc-mobile-tab-more") as HTMLElement | null)?.click();
    });
  }

  afterEach(async () => {
    if (await isDrawerOpen()) {
      await browser.keys(["Escape"]);
      await browser.waitUntil(async () => !(await isDrawerOpen()), { timeout: 3000 }).catch(() => {});
    }
    // Close OmniSearch / any modal that a test left open.
    await browser.keys(["Escape"]);
  });

  it("renders the tab bar at mobile size", async () => {
    const bar = await browser.$(".vc-mobile-tab-bar");
    await bar.waitForDisplayed({ timeout: 3000 });
    const tabs = await browser.$$('[role="tab"]');
    expect(tabs.length).toBe(3);
  });

  it("Files tab opens the drawer", async () => {
    expect(await isDrawerOpen()).toBe(false);
    await clickFilesTab();
    await browser.waitUntil(isDrawerOpen, {
      timeout: 3000,
      timeoutMsg: "Drawer never opened after Files tab click",
    });
  });

  it("Files tab is open-only — second tap leaves the drawer open (no toggle)", async () => {
    await clickFilesTab();
    await browser.waitUntil(isDrawerOpen, { timeout: 3000 });
    await clickFilesTab();
    // Allow time for any unintended close to settle.
    await browser.pause(150);
    expect(await isDrawerOpen()).toBe(true);
  });

  it("Search tab opens OmniSearch (and closes the drawer first if open)", async () => {
    // Regression for Socrates v1 #1 + #7 — drawer-open + Search-tap path.
    // Without the close-drawer-first handler, the scrim's onclick consumes
    // the tap and the modal never opens.
    await clickFilesTab();
    await browser.waitUntil(isDrawerOpen, { timeout: 3000 });
    await clickSearchTab();
    const omni = await browser.$(".vc-omnisearch, .vc-modal-surface");
    await omni.waitForDisplayed({ timeout: 3000 });
    await browser.waitUntil(async () => !(await isDrawerOpen()), {
      timeout: 3000,
      timeoutMsg: "Drawer should close when Search tab is tapped",
    });
  });

  it("More tab shows the placeholder toast (until #397)", async () => {
    await clickMoreTab();
    // toastStore renders into a host that stays in DOM; selector covers
    // the common conventions in this repo.
    const toast = await browser.$(".vc-toast, [role='status']");
    await toast.waitForDisplayed({ timeout: 3000 });
  });

  it("absent at desktop size", async () => {
    await browser.setWindowSize(1280, 900);
    // Wait for the @media-driven re-render.
    await browser.waitUntil(async () => {
      const bars = await browser.$$(".vc-mobile-tab-bar");
      return bars.length === 0;
    }, {
      timeout: 3000,
      timeoutMsg: "Tab bar should be absent at desktop size",
    });
    // Restore mobile size for the after-hook contract.
    await browser.setWindowSize(600, 900);
  });
});
