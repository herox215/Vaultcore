import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Keyboard shortcut rebinding", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openSettings(): Promise<void> {
    const btn = await browser.$('button[aria-label="Einstellungen"]');
    await btn.click();
    await browser.$('[data-testid="settings-modal"]').waitForDisplayed({ timeout: 3000 });
    // Scroll the shortcut section into view so its interactive elements are hit-tested.
    const section = await browser.$('[data-testid="settings-shortcuts"]');
    await section.scrollIntoView();
  }

  async function closeSettings(): Promise<void> {
    const close = await browser.$(".vc-settings-close");
    if (await close.isDisplayed().catch(() => false)) {
      await close.click();
    }
    await browser.$('[data-testid="settings-modal"]').waitForDisplayed({
      timeout: 2000,
      reverse: true,
    });
  }

  it("renders a row for every bound command with a record + reset button", async () => {
    await openSettings();

    const records = await browser.$$('[data-testid="shortcut-record-btn"]');
    expect(records.length).toBeGreaterThanOrEqual(10);

    const resets = await browser.$$('[data-testid="shortcut-reset-btn"]');
    expect(resets.length).toBe(records.length);

    await closeSettings();
  });

  it("enters recording state when the record button is clicked", async () => {
    await openSettings();

    const firstRecord = (await browser.$$('[data-testid="shortcut-record-btn"]'))[0]!;
    await firstRecord.click();

    const recording = await browser.$('[data-testid="shortcut-recording"]');
    await recording.waitForDisplayed({ timeout: 2000 });
    expect(await textOf(recording)).toContain("Drücke");

    // Cancel the recording by pressing Escape so we don't rebind anything.
    await browser.keys(["Escape"]);
    await recording.waitForDisplayed({ timeout: 2000, reverse: true });

    await closeSettings();
  });

  it("resets a command's hotkey when the reset button is clicked", async () => {
    await openSettings();

    // Resetting an unmodified binding is a no-op but must not throw.
    const firstReset = (await browser.$$('[data-testid="shortcut-reset-btn"]'))[0]!;
    await firstReset.click();
    await browser.pause(100);

    // The modal is still open and intact.
    const modal = await browser.$('[data-testid="settings-modal"]');
    expect(await modal.isDisplayed()).toBe(true);

    await closeSettings();
  });

  it("opens the conflict modal when rebinding to a hotkey already in use", async () => {
    // Cmd/Ctrl+N is the default for `File: New note`. Pick the first row
    // that is NOT NEW_NOTE and rebind it to Ctrl+N — the conflict-detection
    // path should surface the alert dialog.
    await openSettings();

    const targetIndex = await browser.execute(() => {
      const recordBtns = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="shortcut-record-btn"]'),
      );
      for (let i = 0; i < recordBtns.length; i++) {
        const row = recordBtns[i]!.closest("tr");
        const action = row?.querySelector(".vc-shortcut-action")?.textContent?.trim() ?? "";
        if (action && !action.toLowerCase().includes("new note")) return i;
      }
      return -1;
    });
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    const recordBtn = (await browser.$$('[data-testid="shortcut-record-btn"]'))[targetIndex]!;
    await recordBtn.click();
    await browser.$('[data-testid="shortcut-recording"]').waitForDisplayed({ timeout: 2000 });

    // The recording listener sits on `<svelte:window>`. Dispatch a
    // synthetic keydown that hotkeyFromEvent maps to { meta: true,
    // key: "n" } — matches NEW_NOTE's default → conflict path is taken.
    await browser.execute(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const conflict = await browser.$('[data-testid="shortcut-conflict"]');
    await conflict.waitForDisplayed({ timeout: 3000 });

    // Cancel the conflict so NEW_NOTE's binding stays intact for follow-on
    // specs.
    await browser.$('[data-testid="shortcut-conflict-cancel"]').click();
    await conflict.waitForDisplayed({ reverse: true, timeout: 2000 });

    await closeSettings();
  });
});
