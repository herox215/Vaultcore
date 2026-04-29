import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

describe("Settings — appearance", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openSettings(): Promise<WebdriverIO.Element> {
    const btn = await browser.$('button[aria-label="Einstellungen"]');
    await btn.waitForDisplayed({ timeout: 3000 });
    await btn.click();
    const modal = await browser.$('[data-testid="settings-modal"]');
    await modal.waitForDisplayed({ timeout: 3000 });
    return modal;
  }

  async function closeSettings(): Promise<void> {
    const close = await browser.$(".vc-settings-close");
    if (await close.isDisplayed().catch(() => false)) {
      await close.click();
    }
    const modal = await browser.$('[data-testid="settings-modal"]');
    await modal.waitForDisplayed({ timeout: 2000, reverse: true });
    // Also wait for the backdrop so the gear button is clickable again.
    await browser.$(".vc-settings-backdrop").waitForDisplayed({ timeout: 2000, reverse: true });
  }

  it("opens and closes the settings modal via the gear button", async () => {
    await openSettings();
    await closeSettings();
  });

  it("switches the theme to Dark and reflects it in documentElement", async () => {
    await openSettings();

    // The native <input type="radio"> is display:none (hidden behind a styled
    // <label>), so click the label instead of the input.
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('input[name="theme"][value="dark"]');
      input?.closest("label")?.click();
    });

    await browser.waitUntil(
      async () => {
        const attr = await browser.execute(() =>
          document.documentElement.getAttribute("data-theme"),
        );
        return attr === "dark";
      },
      { timeout: 2000, timeoutMsg: "documentElement data-theme never became 'dark'" },
    );

    // Reset to auto so later specs don't observe a dark-forced body.
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('input[name="theme"][value="auto"]');
      input?.closest("label")?.click();
    });

    await closeSettings();
  });

  it("changes font size via the slider and updates --vc-font-size", async () => {
    await openSettings();

    const slider = await browser.$("#font-size-slider");
    // Set value and dispatch input so the store picks it up.
    await browser.execute((el: HTMLInputElement) => {
      el.value = "18";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, slider);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--vc-font-size").trim(),
        );
        return v.startsWith("18");
      },
      { timeout: 2000, timeoutMsg: "--vc-font-size never became 18px" },
    );

    // Reset to 15 (default) to avoid leaking state.
    await browser.execute((el: HTMLInputElement) => {
      el.value = "15";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, slider);

    await closeSettings();
  });

  it("switches body font and updates --vc-font-body", async () => {
    await openSettings();

    const select = await browser.$("#font-body-select");
    await browser.execute((el: HTMLSelectElement) => {
      el.value = "inter";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, select);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--vc-font-body").trim(),
        );
        return v.toLowerCase().includes("inter");
      },
      { timeout: 2000, timeoutMsg: "--vc-font-body never became Inter" },
    );

    // Reset to system so later specs start from default.
    await browser.execute((el: HTMLSelectElement) => {
      el.value = "system";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, select);

    await closeSettings();
  });

  it("switches monospace font and updates --vc-font-mono", async () => {
    // Mirror of the body-font test, but exercises the Monospace dropdown.
    // CodeMirror's editor surface inherits `--vc-font-mono`, so this also
    // implicitly verifies the editor will pick the new family on next paint.
    await openSettings();

    const select = await browser.$("#font-mono-select");
    await browser.execute((el: HTMLSelectElement) => {
      el.value = "fira-code";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, select);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--vc-font-mono").trim(),
        );
        return v.toLowerCase().includes("fira");
      },
      { timeout: 2000, timeoutMsg: "--vc-font-mono never became Fira Code" },
    );

    // Reset to default so other specs start clean.
    await browser.execute((el: HTMLSelectElement) => {
      el.value = "system";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, select);

    await closeSettings();
  });
});
