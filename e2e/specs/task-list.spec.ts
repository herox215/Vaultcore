import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * taskList.ts adds a checkbox widget for `- [ ]` / `- [x]` lines and toggles
 * the marker on click. We seed a note with one unchecked task, open it, then
 * click the checkbox and assert the file on disk ends with `- [x]` (autosave
 * writes ≤ 1s after the toggle).
 */
describe("Task list checkbox", () => {
  let vault: TestVault;
  const taskFile = "Tasks.md";
  let taskFilePath: string;

  before(async () => {
    vault = createTestVault();
    taskFilePath = path.join(vault.path, taskFile);
    fs.writeFileSync(
      taskFilePath,
      ["# Tasks", "", "- [ ] First task", "- [ ] Second task", ""].join("\n"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openTreeFile(name: string): Promise<void> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`"${name}" not in tree`);
  }

  it("toggles `- [ ]` to `- [x]` when the checkbox is clicked", async () => {
    await openTreeFile(taskFile);

    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    // Click the first `.cm-task-checkbox` in the active pane.
    const clicked = await browser.execute(() => {
      const panes = Array.from(document.querySelectorAll<HTMLElement>(".cm-content"));
      const active = panes.find((el) => el.offsetParent !== null);
      const box = active?.querySelector<HTMLInputElement>("input.cm-task-checkbox");
      if (!box) return false;
      box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      return true;
    });
    expect(clicked).toBe(true);

    // The in-memory doc flips immediately. Autosave flushes to disk within
    // ~1s — wait for the file to contain "[x]" on the first bullet.
    await browser.waitUntil(
      () => {
        const disk = fs.readFileSync(taskFilePath, "utf-8");
        return /^- \[x\] First task$/m.test(disk);
      },
      { timeout: 5000, timeoutMsg: "First task never flipped to [x] on disk" },
    );
  });
});
