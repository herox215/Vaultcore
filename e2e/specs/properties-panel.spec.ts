import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Properties panel", () => {
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

  async function activatePropertiesSubtab(): Promise<void> {
    await browser.execute(() => {
      const btn = document.querySelector('[aria-label="Properties"][role="tab"]') as HTMLElement | null;
      btn?.click();
    });
    await browser.$(".vc-props-panel").waitForDisplayed({ timeout: 3000 });
  }

  it("shows the empty state when no properties are present", async () => {
    await openTreeFile("Welcome.md");
    await browser.$(".cm-content").waitForDisplayed({ timeout: 5000 });
    await ensureRightSidebar();
    await activatePropertiesSubtab();

    const empty = await browser.$(".vc-props-empty");
    await empty.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(empty)).toContain("Keine Eigenschaften");
  });

  it("adds a property row and commits it to the document", async () => {
    await openTreeFile("Welcome.md");
    await browser.$(".cm-content").waitForDisplayed({ timeout: 5000 });
    await ensureRightSidebar();
    await activatePropertiesSubtab();

    // addRow() is disabled until activeViewStore.view is populated. Wait for
    // the add button to become enabled so the click actually runs the handler.
    const addBtn = await browser.$(".vc-props-add");
    await browser.waitUntil(
      async () => !(await addBtn.getAttribute("disabled")),
      { timeout: 5000, timeoutMsg: ".vc-props-add never became enabled (activeViewStore.view still null)" },
    );
    await addBtn.click();

    await browser.waitUntil(
      async () => (await browser.$$(".vc-props-row")).length >= 1,
      { timeout: 3000, timeoutMsg: "No property row appeared after clicking add" },
    );
    const rows = await browser.$$(".vc-props-row");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // The frontmatter region is hidden from .cm-content by frontmatterPlugin
    // (renders an empty block widget), so we can't read the edit from the
    // visible DOM. Instead, verify the key input of the new row holds the
    // default "property" value — that only gets populated when parseFrontmatter
    // sees the edit round-trip through view.state.doc.
    const keyInput = await browser.$(".vc-props-row .vc-props-key");
    await browser.waitUntil(
      async () => ((await keyInput.getProperty("value")) as string) === "property",
      { timeout: 2000, timeoutMsg: "Added row's key input never showed 'property'" },
    );
  });

  it("deletes a property row and removes the key from the document", async () => {
    // Precondition: previous test left one "property: " row in the frontmatter.
    const delBtn = (await browser.$$(".vc-props-del"))[0]!;
    await delBtn.click();

    // After delete, parsed.properties.length becomes 0, triggering the empty
    // state again. Use that as the observable signal instead of reading the
    // hidden frontmatter region from .cm-content.
    await browser.$(".vc-props-empty").waitForDisplayed({ timeout: 3000 });
    const rows = await browser.$$(".vc-props-row");
    expect(rows.length).toBe(0);
  });
});
