import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

// #174 UAT regression — clicking outside the OmniSearch modal must close it.
// The original implementation wired the backdrop via `onclick`, which requires
// mouseup on the same element as mousedown. A quick mousedown/mouseup pair on
// the backdrop sometimes never produced a click event (e.g. subpixel drift),
// so the dialog stayed open. Switching to `onmousedown` fires dismissal as
// soon as the press lands on the backdrop.
describe("OmniSearch backdrop dismissal (#174)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openOmni(): Promise<void> {
    await browser.keys(["Control", "Shift", "f"]);
    const modal = await browser.$(".vc-quick-switcher-modal");
    await modal.waitForDisplayed({ timeout: 3000 });
  }

  it("closes when the user clicks the backdrop", async () => {
    await openOmni();

    const backdrop = await browser.$(".vc-quick-switcher-backdrop");
    expect(await backdrop.isDisplayed()).toBe(true);

    // Click a corner of the backdrop that is definitely outside the centred
    // modal box (top-left 20px/20px).
    await browser.execute(() => {
      const el = document.querySelector(
        ".vc-quick-switcher-backdrop",
      ) as HTMLElement | null;
      if (!el) return;
      const ev = new MouseEvent("mousedown", {
        bubbles: true,
        clientX: 20,
        clientY: 20,
      });
      el.dispatchEvent(ev);
    });

    await backdrop.waitForDisplayed({ timeout: 2000, reverse: true });
  });

  it("does NOT close when the user clicks inside the modal box", async () => {
    await openOmni();

    const modal = await browser.$(".vc-quick-switcher-modal");
    await browser.execute(() => {
      const el = document.querySelector(
        ".vc-quick-switcher-modal",
      ) as HTMLElement | null;
      if (!el) return;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    // Give the event loop a beat; modal must still be displayed.
    await browser.pause(150);
    expect(await modal.isDisplayed()).toBe(true);

    // Clean up so the next `describe` doesn't inherit an open modal.
    await browser.keys(["Escape"]);
    await modal.waitForDisplayed({ timeout: 2000, reverse: true });
  });
});
