import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

describe("Outgoing Links panel", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
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

  async function ensureRightSidebar(): Promise<void> {
    const wrappers = await browser.$$(".vc-layout-right-sidebar");
    const cls = (await wrappers[0]!.getAttribute("class")) ?? "";
    if (cls.includes("vc-layout-right-sidebar--hidden")) {
      await browser.keys(["Control", "Shift", "b"]);
      await browser.waitUntil(
        async () => {
          const c = (await wrappers[0]!.getAttribute("class")) ?? "";
          return !c.includes("vc-layout-right-sidebar--hidden");
        },
        { timeout: 2000 },
      );
    }
  }

  async function activateOutgoingSubtab(): Promise<void> {
    await browser.execute(() => {
      const btn = document.querySelector('[aria-label="Outgoing Links"][role="tab"]') as HTMLElement | null;
      btn?.click();
    });
    await browser.$('[aria-label="Outgoing Links"][role="complementary"]').waitForDisplayed({ timeout: 3000 });
  }

  it("shows outgoing links for the active note", async () => {
    // Welcome.md links to [[Daily Log]] and [[Ideas]].
    await openTreeFile("Welcome.md");
    // Wait for any visible .cm-content — prior spec tabs may leave hidden ones.
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000, timeoutMsg: "Editor never displayed for Welcome.md" },
    );
    await ensureRightSidebar();
    await activateOutgoingSubtab();

    await browser.waitUntil(
      async () => {
        const rows = await browser.$$(".vc-outlink-row");
        return rows.length >= 2;
      },
      { timeout: 3000, timeoutMsg: "Outgoing links never populated (expected Daily Log + Ideas)" },
    );

    const rows = await browser.$$(".vc-outlink-row");
    const texts = await textsOf(rows);
    const flat = texts.join(" ");
    expect(flat).toContain("Daily Log");
    expect(flat).toContain("Ideas");
  });

  it("shows the empty state for a note with no outgoing links", async () => {
    // subfolder/Another Note.md has no wiki-links.
    await openTreeFile("subfolder");
    await openTreeFile("Another Note.md");

    await browser.waitUntil(
      async () => {
        const empty = await browser.$$(".vc-outlinks-empty");
        return empty.length > 0 && (await empty[0]!.isDisplayed());
      },
      { timeout: 3000, timeoutMsg: "Empty state never rendered for Another Note.md" },
    );
  });

  it("navigates to the linked note when an outgoing row is clicked", async () => {
    await openTreeFile("Welcome.md");
    await activateOutgoingSubtab();
    await browser.waitUntil(
      async () => (await browser.$$(".vc-outlink-row")).length >= 2,
      { timeout: 3000 },
    );

    const rows = await browser.$$(".vc-outlink-row");
    const texts = await textsOf(rows);
    const idx = texts.findIndex((t) => t.includes("Daily Log"));
    if (idx < 0) throw new Error("Daily Log outlink not found");
    await rows[idx]!.click();

    // Active tab label switches to "Daily Log".
    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await browser.waitUntil(
      async () => ((await activeLabel.getProperty("textContent")) as string).includes("Daily Log"),
      { timeout: 3000, timeoutMsg: "Active tab never switched to Daily Log" },
    );
  });

  it("creates the missing note at vault root when an unresolved outlink is clicked", async () => {
    // Wiki Links.md only references [[Welcome]], which exists. Edit the
    // doc to add a brand-new dangling target so the outgoing panel renders
    // an unresolved row we can click.
    await openTreeFile("Wiki Links.md");
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000 },
    );

    const dangling = `Brand New Note ${Date.now()}`;
    // Type the link via the __e2e__ hook so the doc-change goes through
    // the same CM6 transaction path the user would; raw `view.dispatch`
    // requires reaching into CM6 internals that aren't exposed on
    // `.cm-editor`.
    await browser.executeAsync(
      (target: string, done: () => void) => {
        window.__e2e__!.typeInActiveEditor(`\n[[${target}]]\n`).then(() => done());
      },
      dangling,
    );

    await activateOutgoingSubtab();
    await browser.waitUntil(
      async () => {
        const unresolved = await browser.$$(".vc-outlink-row--unresolved");
        for (const el of unresolved) {
          if ((await textOf(el)).includes(dangling)) return true;
        }
        return false;
      },
      { timeout: 5000, timeoutMsg: "unresolved row never appeared for the new target" },
    );

    // Click the unresolved row → click-to-create at vault root.
    await browser.execute((target: string) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-outlink-row--unresolved"),
      );
      const match = rows.find((r) => (r.textContent ?? "").includes(target));
      match?.click();
    }, dangling);

    // The new file appears in the tree and a tab opens for it.
    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes(`${dangling}.md`);
      },
      { timeout: 5000, timeoutMsg: "newly-created note never appeared in tree" },
    );

    const activeLabel = await browser.$(".vc-tab--active .vc-tab-label");
    await browser.waitUntil(
      async () => ((await activeLabel.getProperty("textContent")) as string).includes(dangling),
      { timeout: 3000, timeoutMsg: "active tab never switched to the new note" },
    );
  });
});
