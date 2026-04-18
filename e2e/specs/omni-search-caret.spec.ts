import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

// #174 UAT regression — typing in the OmniSearch input used to snap the caret
// to position 0 whenever the debounced content-mode search fired. The cause
// was `bind:value={query}` combined with a store-subscription callback that
// reassigned the whole `storeState` object on every keystroke, so every
// subsequent re-render re-wrote `input.value` and collapsed the selection.
// The fix replaces `bind:value` with `value={query}` + explicit `oninput`,
// so the DOM no longer disturbs the caret across a search round-trip.
describe("OmniSearch caret preservation (#174)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
    // Let Tantivy finish the initial index build so the content search can
    // actually resolve against fixture content.
    await browser.pause(1500);
  });

  after(() => {
    vault.cleanup();
  });

  it("keeps the caret where the user placed it after the debounce fires", async () => {
    await browser.keys(["Control", "Shift", "f"]);
    const input = await browser.$(".vc-qs-input");
    await input.waitForDisplayed({ timeout: 3000 });

    // Type a query, then deliberately move the caret into the middle of the
    // word and wait past the 200ms debounce so the search actually runs.
    await input.setValue("hello");

    await browser.execute(() => {
      const el = document.querySelector(".vc-qs-input") as
        | HTMLInputElement
        | null;
      if (!el) return;
      el.focus();
      el.setSelectionRange(3, 3);
    });

    // Past the debounce + a comfortable margin for the IPC round-trip.
    await browser.pause(500);

    const [start, end, value] = await browser.execute(() => {
      const el = document.querySelector(".vc-qs-input") as
        | HTMLInputElement
        | null;
      return [el?.selectionStart ?? -1, el?.selectionEnd ?? -1, el?.value ?? ""];
    });

    expect(value).toBe("hello");
    expect(start).toBe(3);
    expect(end).toBe(3);

    await browser.keys(["Escape"]);
  });
});
