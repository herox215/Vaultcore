import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

describe("Graph forces dialog", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openGraph(): Promise<void> {
    await browser.keys(["Control", "Shift", "g"]);
    await browser.$(".vc-graph-view").waitForDisplayed({ timeout: 5000 });
  }

  async function openForces(): Promise<void> {
    const btn = await browser.$('.vc-graph-forces-btn, [aria-label="Forces"]');
    await btn.waitForDisplayed({ timeout: 3000 });
    await btn.click();
    await browser.$(".vc-forces-panel").waitForDisplayed({ timeout: 3000 });
  }

  it("opens the forces panel from the graph tab", async () => {
    await openGraph();
    await openForces();

    const panel = await browser.$(".vc-forces-panel");
    expect(await panel.isDisplayed()).toBe(true);

    // All four sliders are present.
    const sliders = await browser.$$('.vc-forces-panel input[type="range"]');
    expect(sliders.length).toBe(4);
  });

  it("updates the value readout when a slider is moved", async () => {
    // Precondition: forces panel is open from the previous test.
    const sliders = await browser.$$('.vc-forces-panel input[type="range"]');
    const first = sliders[0]!;
    const original = (await first.getProperty("value")) as string;

    // Set the slider to a different value and dispatch input.
    const target = String(Number(original) + 1 <= 5 ? Number(original) + 1 : Number(original) - 1);
    await browser.execute((el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, first, target);

    // The corresponding value readout updates.
    const values = await browser.$$('.vc-forces-value');
    const first$ = values[0]!;
    await browser.waitUntil(
      async () => ((await first$.getProperty("textContent")) as string).trim() === Number(target).toFixed(2),
      { timeout: 2000, timeoutMsg: "Value readout did not match the new slider value" },
    );
  });

  it("toggles the freeze button between Pause and Play states", async () => {
    const btn = await browser.$(".vc-forces-freeze");
    const initial = (await btn.getAttribute("aria-pressed")) ?? "false";
    await btn.click();
    await browser.waitUntil(
      async () => ((await btn.getAttribute("aria-pressed")) ?? "") !== initial,
      { timeout: 2000, timeoutMsg: "Freeze button aria-pressed never flipped" },
    );

    // Flip back.
    await btn.click();
    await browser.waitUntil(
      async () => ((await btn.getAttribute("aria-pressed")) ?? "") === initial,
      { timeout: 2000, timeoutMsg: "Freeze button did not return to initial state" },
    );
  });

  it("closes the forces panel when the close button is clicked", async () => {
    // WebDriver's native click is intercepted by an overlapping element in the
    // graph viewport; dispatch the click programmatically.
    await browser.execute(() => {
      const btn = document.querySelector<HTMLButtonElement>(".vc-forces-close");
      btn?.click();
    });
    await browser.$(".vc-forces-panel").waitForDisplayed({ timeout: 2000, reverse: true });
  });
});
