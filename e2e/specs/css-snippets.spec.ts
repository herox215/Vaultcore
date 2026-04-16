import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textsOf } from "../helpers/text.js";

describe("CSS snippets", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();

    // Seed a snippet on disk before opening the vault so the backend picks it
    // up on the initial snippets scan.
    const snippetsDir = path.join(vault.path, ".vaultcore", "snippets");
    fs.mkdirSync(snippetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(snippetsDir, "red-accent.css"),
      "body { --color-accent: rgb(255, 0, 0); }\n",
      "utf-8",
    );

    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openSettings(): Promise<void> {
    // If a previous test left the backdrop lingering (e.g. on spec failure),
    // make sure the gear is clickable before trying.
    await browser.$(".vc-settings-backdrop").waitForDisplayed({ timeout: 2000, reverse: true }).catch(() => {});
    const btn = await browser.$('button[aria-label="Einstellungen"]');
    await btn.click();
    const modal = await browser.$('[data-testid="settings-modal"]');
    await modal.waitForDisplayed({ timeout: 3000 });
  }

  async function closeSettings(): Promise<void> {
    const close = await browser.$(".vc-settings-close");
    if (await close.isDisplayed().catch(() => false)) {
      await close.click();
    }
    const modal = await browser.$('[data-testid="settings-modal"]');
    await modal.waitForDisplayed({ timeout: 2000, reverse: true });
    await browser.$(".vc-settings-backdrop").waitForDisplayed({ timeout: 2000, reverse: true });
  }

  it("lists snippets found on disk", async () => {
    await openSettings();

    // The snippets are loaded when the vault opens — give the store a moment
    // and force a refresh in case the load hook hasn't fired yet.
    const refresh = await browser.$(".vc-snippets-refresh");
    await refresh.click();

    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-snippets-name"));
        return names.includes("red-accent.css");
      },
      { timeout: 3000, timeoutMsg: "red-accent.css never appeared in the snippets list" },
    );

    await closeSettings();
  });

  it("injects a <style data-snippet> tag when a snippet is toggled on", async () => {
    await openSettings();

    // Find the checkbox for the snippet. The input is styled opacity:0 and
    // positioned over a custom toggle track — not "displayed" per WDIO — so
    // wait for existence, not display.
    const checkbox = await browser.$('input[aria-label="Snippet red-accent.css aktivieren"]');
    await checkbox.waitForExist({ timeout: 3000 });
    const isChecked = await checkbox.isSelected();
    if (!isChecked) {
      // Clicking the input directly is unreliable when a custom toggle track
      // sits on top — dispatch a programmatic change.
      await browser.execute((el: HTMLInputElement) => {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, checkbox);
    }

    await browser.waitUntil(
      async () => {
        const present = await browser.execute(() =>
          document.head.querySelector('style[data-snippet="red-accent.css"]') !== null,
        );
        return present;
      },
      { timeout: 3000, timeoutMsg: "Snippet style tag never appeared in document.head" },
    );

    await closeSettings();
  });

  it("removes the style tag when a snippet is toggled off", async () => {
    await openSettings();

    const checkbox = await browser.$('input[aria-label="Snippet red-accent.css aktivieren"]');
    await browser.execute((el: HTMLInputElement) => {
      el.checked = false;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, checkbox);

    await browser.waitUntil(
      async () => {
        const present = await browser.execute(() =>
          document.head.querySelector('style[data-snippet="red-accent.css"]') !== null,
        );
        return !present;
      },
      { timeout: 3000, timeoutMsg: "Snippet style tag never disappeared" },
    );

    await closeSettings();
  });
});
