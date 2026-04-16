import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Tab navigation", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function openSidebarNote(name: string): Promise<void> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`"${name}" not in tree`);
  }

  async function waitForActiveTab(name: string): Promise<void> {
    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await activeLabel.waitForDisplayed({ timeout: 5000 });
    await browser.waitUntil(async () => (await textOf(activeLabel)) === name, {
      timeout: 3000,
      timeoutMsg: `Active tab never became "${name}"`,
    });
  }

  it("cycles to the next tab on Ctrl+Tab and wraps at the end", async () => {
    await openSidebarNote("Welcome.md");
    await waitForActiveTab("Welcome.md");
    await openSidebarNote("Daily Log.md");
    await waitForActiveTab("Daily Log.md");
    await openSidebarNote("Ideas.md");
    await waitForActiveTab("Ideas.md");

    // Ctrl+Tab moves active pointer forward. Tab order matches open order.
    await browser.keys(["Control", "Tab"]);
    await waitForActiveTab("Welcome.md");

    await browser.keys(["Control", "Tab"]);
    await waitForActiveTab("Daily Log.md");

    await browser.keys(["Control", "Tab"]);
    await waitForActiveTab("Ideas.md");
  });

  it("closes the active tab on Ctrl+W", async () => {
    // Ideas.md is active from the prior test.
    const before = await textsOf(await browser.$$(".vc-tab-label"));
    expect(before).toContain("Ideas.md");

    await browser.keys(["Control", "w"]);

    await browser.waitUntil(
      async () => {
        const labels = await textsOf(await browser.$$(".vc-tab-label"));
        return !labels.includes("Ideas.md");
      },
      { timeout: 3000, timeoutMsg: "Ideas.md tab never closed on Ctrl+W" },
    );

    // Some other tab should become active now.
    const remaining = await textsOf(await browser.$$(".vc-tab-label"));
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("closes a tab when clicking its X button", async () => {
    // Close Welcome.md via its close button — find the tab by label.
    await browser.execute((target: string) => {
      const tabs = document.querySelectorAll(".vc-tab");
      for (const tab of Array.from(tabs)) {
        const label = tab.querySelector(".vc-tab-label");
        if (label && (label.textContent ?? "").trim() === target) {
          const closeBtn = tab.querySelector(".vc-tab-close") as HTMLElement | null;
          closeBtn?.click();
          return;
        }
      }
    }, "Welcome.md");

    await browser.waitUntil(
      async () => {
        const labels = await textsOf(await browser.$$(".vc-tab-label"));
        return !labels.includes("Welcome.md");
      },
      { timeout: 3000, timeoutMsg: "Welcome.md tab never closed on X click" },
    );
  });

  it("closing the last tab leaves no active tab", async () => {
    // Close the remaining tab(s) with Ctrl+W until none are left.
    for (let i = 0; i < 5; i++) {
      const labels = await textsOf(await browser.$$(".vc-tab-label"));
      if (labels.length === 0) break;
      await browser.keys(["Control", "w"]);
      await browser.pause(150);
    }

    const tabs = await browser.$$(".vc-tab");
    expect(tabs.length).toBe(0);

    const activeTabs = await browser.$$(".vc-tab--active");
    expect(activeTabs.length).toBe(0);
  });

  it("is a no-op when Ctrl+Tab fires with no open tabs", async () => {
    await browser.keys(["Control", "Tab"]);
    await browser.pause(200);
    const tabs = await browser.$$(".vc-tab");
    expect(tabs.length).toBe(0);
  });
});
