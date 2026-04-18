import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

describe("Sidebar layout", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  // Collapse is driven by setting the .vc-layout-sidebar container to
  // width: 0 via the --collapsed modifier. The inner <aside
  // data-testid="sidebar"> stays in the DOM, so isDisplayed() is not a
  // reliable signal — check the container class instead.
  async function isSidebarCollapsed(): Promise<boolean> {
    const wrapper = await browser.$(".vc-layout-sidebar");
    const cls = (await wrapper.getAttribute("class")) ?? "";
    return cls.includes("vc-layout-sidebar--collapsed");
  }

  it("collapses and re-expands the sidebar via the topbar buttons", async () => {
    expect(await isSidebarCollapsed()).toBe(false);

    const collapseBtn = await browser.$('[aria-label="Collapse sidebar"]');
    await collapseBtn.waitForDisplayed({ timeout: 3000 });
    await browser.execute(() => {
      (document.querySelector('[aria-label="Collapse sidebar"]') as HTMLElement | null)?.click();
    });

    await browser.waitUntil(isSidebarCollapsed, {
      timeout: 3000,
      timeoutMsg: "Sidebar never collapsed after clicking collapse button",
    });

    const expandBtn = await browser.$('[aria-label="Expand sidebar"]');
    await expandBtn.waitForDisplayed({ timeout: 3000 });
    await browser.execute(() => {
      (document.querySelector('[aria-label="Expand sidebar"]') as HTMLElement | null)?.click();
    });
    await browser.waitUntil(async () => !(await isSidebarCollapsed()), {
      timeout: 3000,
      timeoutMsg: "Sidebar never expanded after clicking expand button",
    });
  });

  it("switches between Dateien / Tags sidebar tabs", async () => {
    // #174 removed the dedicated "Suche" sidebar tab — search moved into
    // the OmniSearch modal (Ctrl+Shift+F). Only two tabs remain.
    //
    // Dispatch clicks through the DOM — the 200ms sidebar-expand CSS
    // transition leaves WebKitWebDriver briefly reporting elements as
    // "not interactable" even though they are fully rendered.
    async function clickTabByLabel(label: string): Promise<void> {
      await browser.execute((target: string) => {
        const btns = document.querySelectorAll(".vc-sidebar-tab");
        for (const b of Array.from(btns)) {
          if ((b.textContent ?? "").trim().includes(target)) {
            (b as HTMLElement).click();
            return;
          }
        }
      }, label);
    }

    await clickTabByLabel("Tags");
    const tagsPanel = await browser.$(".vc-tags-panel, [data-testid='tags-panel']");
    await tagsPanel.waitForDisplayed({ timeout: 3000 });

    await clickTabByLabel("Dateien");
    const tree = await browser.$(".vc-sidebar-tree");
    await tree.waitForDisplayed({ timeout: 3000 });
  });
});
