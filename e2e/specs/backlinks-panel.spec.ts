import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Backlinks panel", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();

    // Add a standalone file that nothing else links to — used to verify the
    // empty-backlinks state. Every fixture already has inbound links, so we
    // need a new isolate file to exercise the "Keine Backlinks" branch.
    fs.writeFileSync(
      path.join(vault.path, "Isolated.md"),
      "# Isolated\n\nNothing links here.\n",
      "utf-8",
    );

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

  // The topbar toggle + Ctrl+Shift+B both call backlinksStore.toggle(), which
  // only controls right-sidebar visibility. RightSidebar is a tabbed panel
  // (Properties / Outline / Outgoing / Backlinks) with its own localStorage-
  // backed active tab — defaults to Properties, so the backlinks panel only
  // renders when the Backlinks sub-tab is also selected.
  async function activateBacklinksSubtab(): Promise<void> {
    await browser.execute(() => {
      const btn = document.querySelector('[aria-label="Backlinks"][role="tab"]') as HTMLElement | null;
      btn?.click();
    });
  }

  // The right-sidebar wrapper is always mounted; width flips between 0 and
  // backlinksWidth via CSS. The --hidden modifier class is the authoritative
  // open/close signal.
  async function isRightSidebarOpen(): Promise<boolean> {
    const wrappers = await browser.$$(".vc-layout-right-sidebar");
    if (wrappers.length === 0) return false;
    const cls = (await wrappers[0]!.getAttribute("class")) ?? "";
    return !cls.includes("vc-layout-right-sidebar--hidden");
  }

  // Force the right sidebar closed by reading the store state and dispatching
  // the shortcut only when it would actually toggle to closed. Using the
  // wrapper --hidden class alone is unreliable as a baseline because
  // localStorage (STORAGE_KEY_OPEN) persists across test sessions and Svelte's
  // mount uses the stored value.
  async function forceClosed(): Promise<void> {
    if (await isRightSidebarOpen()) {
      await browser.keys(["Control", "Shift", "b"]);
      await browser.waitUntil(async () => !(await isRightSidebarOpen()), {
        timeout: 3000,
        timeoutMsg: "Could not close right sidebar via Ctrl+Shift+B",
      });
    }
  }

  it("toggles via Ctrl+Shift+B", async () => {
    await forceClosed();

    await browser.keys(["Control", "Shift", "b"]);
    await browser.waitUntil(isRightSidebarOpen, {
      timeout: 3000,
      timeoutMsg: "Ctrl+Shift+B did not open the right sidebar",
    });

    await browser.keys(["Control", "Shift", "b"]);
    await browser.waitUntil(async () => !(await isRightSidebarOpen()), {
      timeout: 3000,
      timeoutMsg: "Ctrl+Shift+B did not close the right sidebar",
    });
  });

  it("shows the empty state for a note with no inbound links", async () => {
    await forceClosed();
    await openSidebarNote("Isolated.md");
    const cm = await browser.$(".cm-content");
    await cm.waitForDisplayed({ timeout: 5000 });

    await browser.keys(["Control", "Shift", "b"]);
    await browser.waitUntil(isRightSidebarOpen, {
      timeout: 3000,
      timeoutMsg: "Right sidebar never opened",
    });
    await activateBacklinksSubtab();

    const panel = await browser.$(".vc-backlinks-panel");
    await panel.waitForDisplayed({ timeout: 3000 });

    const emptyHeading = await browser.$(".vc-backlinks-empty-heading");
    await emptyHeading.waitForDisplayed({ timeout: 5000 });
    expect(await textOf(emptyHeading)).toContain("Keine Backlinks");

    await browser.keys(["Control", "Shift", "b"]);
    await browser.waitUntil(async () => !(await isRightSidebarOpen()), {
      timeout: 3000,
      timeoutMsg: "Right sidebar never closed after cleanup",
    });
  });

  it("renders a backlink row for a linked note", async () => {
    // Welcome.md is linked from Daily Log.md, Ideas.md, and Wiki Links.md.
    await openSidebarNote("Welcome.md");
    // The previous test left Isolated.md's .cm-content mounted but hidden
    // (display:none). $(".cm-content") returns the first match, which may be
    // hidden — instead wait for ANY .cm-content to be visible.
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) {
          if (await el.isDisplayed()) return true;
        }
        return false;
      },
      { timeout: 5000, timeoutMsg: "No visible .cm-content after opening Welcome.md" },
    );

    await browser.keys(["Control", "Shift", "b"]);
    await browser.waitUntil(isRightSidebarOpen, {
      timeout: 3000,
      timeoutMsg: "Right sidebar never opened",
    });
    await activateBacklinksSubtab();

    const panel = await browser.$(".vc-backlinks-panel");
    await panel.waitForDisplayed({ timeout: 3000 });

    // Wait for async backlink resolution to populate the body.
    await browser.waitUntil(
      async () => {
        const empty = await browser.$$(".vc-backlinks-empty-heading");
        if (empty.length > 0) return false;
        const body = await browser.$(".vc-backlinks-body");
        const txt = (await body.getProperty("textContent")) as string;
        return txt.trim().length > 0 && !txt.includes("Lade Backlinks");
      },
      { timeout: 5000, timeoutMsg: "Backlinks never populated for Welcome.md" },
    );
  });
});
