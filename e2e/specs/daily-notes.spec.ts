import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textsOf } from "../helpers/text.js";

/**
 * Daily notes resolve a filename from the configured date format. The
 * default format (`YYYY/MM/DD`) produces a path with slashes, which the
 * backend renders as nested folders — not a single tree node. To keep the
 * spec deterministic across date rollovers and time zones, we override the
 * format to a flat filename (`YYYY-MM-DD`) via settingsStore before firing
 * the shortcut, then compute today's filename in the same way here.
 */
describe("Daily notes", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  function todayFilename(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}.md`;
  }

  async function setDailyFormat(format: string): Promise<void> {
    const btn = await browser.$('button[aria-label="Einstellungen"]');
    await btn.click();
    const input = await browser.$('[data-testid="settings-daily-format"]');
    await input.waitForDisplayed({ timeout: 3000 });
    await browser.execute((el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, input, format);
    const close = await browser.$(".vc-settings-close");
    await close.click();
    await browser.$('[data-testid="settings-modal"]').waitForDisplayed({
      timeout: 2000,
      reverse: true,
    });
  }

  it("creates and opens today's note on Ctrl+Shift+D", async () => {
    await setDailyFormat("YYYY-MM-DD");
    const expected = todayFilename();

    await browser.keys(["Control", "Shift", "d"]);

    // Sidebar tree refreshes asynchronously after the file write.
    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes(expected);
      },
      { timeout: 5000, timeoutMsg: `"${expected}" never appeared in the tree` },
    );

    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await browser.waitUntil(
      async () => (await activeLabel.getProperty("textContent")) === expected,
      { timeout: 3000, timeoutMsg: "Daily note never became the active tab" },
    );

    // Sanity check: the file is actually on disk.
    expect(fs.existsSync(path.join(vault.path, expected))).toBe(true);
  });

  it("is idempotent — a second Ctrl+Shift+D re-opens the same note, not a new one", async () => {
    const expected = todayFilename();
    // Open another file to push daily note out of focus.
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await n.getProperty("textContent")) === "Welcome.md") {
        await n.click();
        break;
      }
    }
    await browser.pause(200);

    await browser.keys(["Control", "Shift", "d"]);
    await browser.pause(300);

    // Still exactly one tab with today's name.
    const labels = await textsOf(await browser.$$(".vc-tab-label"));
    const count = labels.filter((l) => l === expected).length;
    expect(count).toBe(1);
  });
});
