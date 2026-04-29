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
    // `settingsStore` persists to localStorage which survives across spec
    // sessions, so any pollution from prior runs (template path, custom
    // folder) leaks in. Reset folder + template to defaults here so each
    // session starts from a clean slate regardless of the previous one.
    const folderInput = await browser.$('[data-testid="settings-daily-folder"]');
    await browser.execute((el: HTMLInputElement) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, folderInput);
    const tplInput = await browser.$('[data-testid="settings-daily-template"]');
    await browser.execute((el: HTMLInputElement) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, tplInput);
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

  it("seeds new daily notes from the configured template", async () => {
    // Drop a template file with a stable marker so the assertion doesn't
    // need to depend on date interpolation. The daily-notes flow reads
    // the template via `readFile` then writes it into the new note —
    // template tokens are not currently expanded by this code path.
    const templateRelPath = "Templates/Daily Template.md";
    const templateContent = "# Daily template\n\nMarker: e2e-daily-template-seed\n";
    fs.mkdirSync(path.join(vault.path, "Templates"), { recursive: true });
    fs.writeFileSync(path.join(vault.path, templateRelPath), templateContent, "utf-8");

    // Configure a NEW daily folder so a fresh file path is generated —
    // earlier tests already created today's note in the vault root.
    const btn = await browser.$('button[aria-label="Einstellungen"]');
    await btn.click();
    const folderInput = await browser.$('[data-testid="settings-daily-folder"]');
    await folderInput.waitForDisplayed({ timeout: 3000 });
    await browser.execute((el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, folderInput, "Daily-Tpl");

    const tplInput = await browser.$('[data-testid="settings-daily-template"]');
    await browser.execute((el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, tplInput, templateRelPath);

    const close = await browser.$(".vc-settings-close");
    await close.click();
    await browser.$('[data-testid="settings-modal"]').waitForDisplayed({
      timeout: 2000,
      reverse: true,
    });

    await browser.keys(["Control", "Shift", "d"]);

    const expected = todayFilename();
    const newAbs = path.join(vault.path, "Daily-Tpl", expected);
    await browser.waitUntil(
      () => Promise.resolve(fs.existsSync(newAbs)),
      { timeout: 5000, timeoutMsg: `${newAbs} never written` },
    );

    // Daily note must contain the template marker — proves the seeding
    // path did the read+write; an empty file means the readFile failed
    // silently and the user gets a blank note (per AC, that fallback
    // must not block creation, but the happy path shouldn't take it).
    await browser.waitUntil(
      () => {
        try {
          const content = fs.readFileSync(newAbs, "utf-8");
          return Promise.resolve(content.includes("e2e-daily-template-seed"));
        } catch {
          return Promise.resolve(false);
        }
      },
      { timeout: 3000, timeoutMsg: "daily note was never seeded with the template content" },
    );

    // Reset daily-notes settings — `settingsStore` is global (not
    // vault-scoped), so leaving "Daily-Tpl" + a template path in place
    // would change what the *next* spec session sees on cold start.
    const reopenBtn = await browser.$('button[aria-label="Einstellungen"]');
    await reopenBtn.click();
    const folderResetInput = await browser.$('[data-testid="settings-daily-folder"]');
    await folderResetInput.waitForDisplayed({ timeout: 3000 });
    await browser.execute((el: HTMLInputElement) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, folderResetInput);
    const tplResetInput = await browser.$('[data-testid="settings-daily-template"]');
    await browser.execute((el: HTMLInputElement) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, tplResetInput);
    await (await browser.$(".vc-settings-close")).click();
    await browser.$('[data-testid="settings-modal"]').waitForDisplayed({
      timeout: 2000,
      reverse: true,
    });
  });
});
