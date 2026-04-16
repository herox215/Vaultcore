import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Toast notifications", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function pushToast(message: string, variant = "error"): Promise<void> {
    // Toasts surface from a variety of async failure paths (IPC errors,
    // broken link resolution, etc.) that are hard to provoke deterministically
    // from the driver. The __e2e__ hook exposes `pushToast` so we can exercise
    // the rendering pipeline directly, which is what this spec verifies.
    await browser.execute(
      (variantArg: string, msg: string) => {
        const hook = (window as unknown as {
          __e2e__: { pushToast: (v: string, m: string) => void };
        }).__e2e__;
        hook.pushToast(variantArg, msg);
      },
      variant,
      message,
    );
  }

  it("renders a toast when one is pushed to the store", async () => {
    await pushToast("E2E test notification", "error");

    const toast = await browser.$('[data-testid="toast"]');
    await toast.waitForDisplayed({ timeout: 3000 });
    const msg = await browser.$(".vc-toast-message");
    expect(await textOf(msg)).toContain("E2E test notification");
  });

  it("dismisses the toast when the close button is clicked", async () => {
    const toast = await browser.$('[data-testid="toast"]');
    const dismiss = await browser.$(".vc-toast-dismiss");
    await dismiss.click();
    await toast.waitForDisplayed({ timeout: 3000, reverse: true });
  });

  it("stacks multiple toasts vertically in the container", async () => {
    await pushToast("First stacked toast", "error");
    await pushToast("Second stacked toast", "conflict");
    await pushToast("Third stacked toast", "clean-merge");

    await browser.waitUntil(
      async () => (await browser.$$('[data-testid="toast"]')).length >= 3,
      { timeout: 3000, timeoutMsg: "Three toasts never stacked" },
    );

    // Cleanup so later specs don't see leftover toasts.
    const dismissBtns = await browser.$$(".vc-toast-dismiss");
    for (const b of dismissBtns) {
      await b.click().catch(() => {});
    }
    await browser.waitUntil(
      async () => (await browser.$$('[data-testid="toast"]')).length === 0,
      { timeout: 3000 },
    );
  });
});
