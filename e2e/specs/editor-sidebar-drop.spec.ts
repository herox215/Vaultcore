import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

/**
 * #146 — dragging a note from the sidebar into an editor pane must open it
 * in a new split. The existing `drag-drop.spec.ts` is skipped because the
 * tree's DnD contract round-trips `dataTransfer` through the browser-generated
 * event (setData in `ondragstart` → getData in `ondrop`), which WebKit makes
 * read-only for synthetic events. The editor drop handler here reads the
 * payload from the *same* DataTransfer we build in the test, so a direct
 * dispatch works and this spec can run.
 */
describe("Editor: sidebar file drop (#146)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function findTreeNode(name: string): Promise<WebdriverIO.Element> {
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) return n;
    }
    throw new Error(`"${name}" not in tree`);
  }

  it("ignores a folder drag (no second pane created)", async () => {
    const welcome = await findTreeNode("Welcome.md");
    await welcome.click();
    await browser.pause(200);

    const folderNode = await findTreeNode("subfolder");
    const pane = await browser.$(".vc-editor-pane");
    await pane.waitForDisplayed({ timeout: 3000 });

    await browser.execute(
      (src: HTMLElement, tgt: HTMLElement, payload: string) => {
        const rect = tgt.getBoundingClientRect();
        const edgeX = Math.round(rect.right - 10);
        const midY = Math.round(rect.top + rect.height / 2);
        const dt = new DataTransfer();
        dt.setData("text/vaultcore-folder", payload);
        dt.effectAllowed = "move";
        const fire = (type: "dragover" | "drop", el: HTMLElement, x: number, y: number) => {
          const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
          Object.defineProperty(ev, "dataTransfer", { value: dt, writable: false });
          Object.defineProperty(ev, "clientX", { value: x });
          Object.defineProperty(ev, "clientY", { value: y });
          el.dispatchEvent(ev);
        };
        fire("dragover", tgt, edgeX, midY);
        fire("drop", tgt, edgeX, midY);
      },
      folderNode,
      pane,
      `${vault.path}/subfolder`,
    );

    await browser.pause(400);
    const panes = await browser.$$(".vc-editor-pane");
    expect(panes.length).toBe(1);
  });

  it("drops a .md note onto the right edge and creates a right-pane split", async () => {
    // Leave the seed tab (Welcome.md) open from the previous test.
    const sourceNode = await findTreeNode("Ideas.md");
    const pane = await browser.$(".vc-editor-pane");
    await pane.waitForDisplayed({ timeout: 3000 });

    await browser.execute(
      (src: HTMLElement, tgt: HTMLElement, payload: string) => {
        const rect = tgt.getBoundingClientRect();
        const edgeX = Math.round(rect.right - 10);
        const midY = Math.round(rect.top + rect.height / 2);

        const dt = new DataTransfer();
        dt.setData("text/vaultcore-file", payload);
        dt.effectAllowed = "move";

        const fire = (type: "dragstart" | "dragover" | "drop" | "dragend", el: HTMLElement, x: number, y: number) => {
          const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
          Object.defineProperty(ev, "dataTransfer", { value: dt, writable: false });
          Object.defineProperty(ev, "clientX", { value: x });
          Object.defineProperty(ev, "clientY", { value: y });
          el.dispatchEvent(ev);
        };

        fire("dragstart", src, 0, 0);
        fire("dragover", tgt, edgeX, midY);
        fire("drop", tgt, edgeX, midY);
        fire("dragend", src, edgeX, midY);
      },
      sourceNode,
      pane,
      `${vault.path}/Ideas.md`,
    );

    await browser.waitUntil(
      async () => {
        const panes = await browser.$$(".vc-editor-pane");
        return panes.length === 2;
      },
      { timeout: 3000, timeoutMsg: "Split view was not created after the drop" },
    );

    const panes = await browser.$$(".vc-editor-pane");
    // Ideas.md should be the active tab of the right-hand pane.
    const rightActive = await panes[1]!.$(".vc-tab--active .vc-tab-label");
    await browser.waitUntil(
      async () => (await rightActive.getProperty("textContent")) === "Ideas.md",
      { timeout: 3000, timeoutMsg: "Ideas.md did not become the active tab in the right pane" },
    );
  });

});
