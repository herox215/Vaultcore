import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * E2E coverage for issue #130 — keyboard handlers on role="button" canvas
 * node cards. Tests Enter + Space activation per card type:
 *   - Text node    → enters edit mode (textarea appears)
 *   - File (md)    → opens the referenced note as a tab
 *   - Link         → calls window.open with the URL
 *   - Unknown      → becomes the selected node
 *   - Edge label   → enters edit mode for the edge label
 *
 * Edge cases:
 *   - Space must preventDefault so the page doesn't scroll.
 *   - A non-activating key (ArrowUp) must NOT fire the action.
 */

const DOC = {
  nodes: [
    { id: "text-a",    type: "text",    x: -400, y: -200, width: 180, height: 60,  text: "Hallo" },
    { id: "file-md-1", type: "file",    x: -180, y: -220, width: 260, height: 160, file: "Note.md" },
    { id: "link-1",    type: "link",    x: -180, y:   40, width: 260, height: 80,  url: "https://example.com/a11y" },
    { id: "diag-1",    type: "diagram", x:  180, y:   40, width: 160, height: 80 },
  ],
  edges: [
    { id: "e1", fromNode: "text-a", fromSide: "right", toNode: "file-md-1", toSide: "left", label: "verknüpft" },
  ],
};

describe("Canvas a11y — keyboard activation (#130)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    fs.writeFileSync(path.join(vault.path, "Note.md"), "# Note body", "utf-8");
    fs.writeFileSync(
      path.join(vault.path, "A11y.canvas"),
      JSON.stringify(DOC, null, "\t"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function activeTabId(): Promise<string> {
    const id = await browser.execute(() => {
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      return visible?.getAttribute("data-tab-id") ?? null;
    });
    if (!id) throw new Error("No visible canvas viewport found");
    return id as string;
  }

  async function vizSel(suffix = ""): Promise<string> {
    const id = await activeTabId();
    return `.vc-canvas-viewport[data-tab-id="${id}"]${suffix}`;
  }

  async function openTreeFile(name: string): Promise<void> {
    await browser.waitUntil(
      async () => {
        const names = await textsOf(await browser.$$(".vc-tree-name"));
        return names.includes(name);
      },
      { timeout: 5000, timeoutMsg: `"${name}" never appeared in the tree` },
    );
    const nodes = await browser.$$(".vc-tree-name");
    for (const n of nodes) {
      if ((await textOf(n)) === name) {
        await n.click();
        return;
      }
    }
    throw new Error(`"${name}" not found`);
  }

  async function waitForCanvas(): Promise<void> {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const vps = Array.from(
            document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
          );
          const visible = vps.find((v) => v.offsetParent !== null);
          return !!visible?.querySelector(".vc-canvas-world");
        }),
      { timeout: 5000, timeoutMsg: "Canvas world never mounted" },
    );
  }

  /**
   * Dispatch a `keydown` event directly on the node card DOM element. We use
   * this rather than webdriver `browser.keys()` because the WebKit driver's
   * synthetic-keystroke pipe doesn't reliably deliver Space/Enter to a
   * contenteditable-adjacent div. The handler under test only checks
   * `e.key` and `e.preventDefault()`, so synthesizing the event suffices.
   * Returns `true` if the handler called `preventDefault()`.
   */
  async function pressKey(
    selector: string,
    key: string,
  ): Promise<boolean> {
    return browser.execute(
      (sel: string, k: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) throw new Error(`No element matches ${sel}`);
        const ev = new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      selector,
      key,
    );
  }

  beforeEach(async () => {
    await openTreeFile("A11y.canvas");
    await waitForCanvas();
  });

  it("Enter on a text-node card enters edit mode", async () => {
    const sel = await vizSel(' [data-node-id="text-a"]');
    const prevented = await pressKey(sel, "Enter");
    expect(prevented).toBe(true);

    // Edit mode puts a <textarea> inside the node card.
    const textarea = await browser.$(`${sel} textarea.vc-canvas-node-textarea`);
    await textarea.waitForDisplayed({ timeout: 3000 });
  });

  it("Space on a text-node card also enters edit mode and calls preventDefault", async () => {
    const sel = await vizSel(' [data-node-id="text-a"]');
    const prevented = await pressKey(sel, " ");
    expect(prevented).toBe(true);
    const textarea = await browser.$(`${sel} textarea.vc-canvas-node-textarea`);
    await textarea.waitForDisplayed({ timeout: 3000 });
  });

  it("ArrowUp on a text-node card is ignored (no edit-mode, no preventDefault)", async () => {
    const sel = await vizSel(' [data-node-id="text-a"]');
    const prevented = await pressKey(sel, "ArrowUp");
    expect(prevented).toBe(false);
    const textarea = await browser.$(`${sel} textarea.vc-canvas-node-textarea`);
    expect(await textarea.isExisting()).toBe(false);
  });

  it("Enter on a file (markdown) card opens the referenced note", async () => {
    const sel = await vizSel(' [data-node-type="file"]');
    await pressKey(sel, "Enter");

    // A new editor tab with the note's basename should appear.
    await browser.waitUntil(
      async () => {
        const tabs = await textsOf(await browser.$$(".vc-tab-label"));
        return tabs.some((t) => t === "Note.md" || t === "Note");
      },
      { timeout: 5000, timeoutMsg: "Note tab never opened" },
    );
  });

  it("Enter on a link card calls window.open with the URL", async () => {
    // Install a spy for window.open so we can assert the URL without actually
    // navigating. The spy is torn down at the end of the test.
    const captured = await browser.executeAsync(
      async (sel: string, done: (url: string | null) => void) => {
        const original = window.open;
        let seen: string | null = null;
        (window as unknown as {
          open: (u?: string | URL) => Window | null;
        }).open = (u?: string | URL) => {
          seen = typeof u === "string" ? u : u?.toString() ?? null;
          return null;
        };
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) {
          window.open = original;
          done(null);
          return;
        }
        const ev = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
        // Give the handler a tick to run (synchronous in our case).
        setTimeout(() => {
          window.open = original;
          done(seen);
        }, 50);
      },
      await vizSel(' [data-node-type="link"]'),
    );
    expect(captured).toBe("https://example.com/a11y");
  });

  it("Enter on an unknown-type card selects the node", async () => {
    const sel = await vizSel(' [data-node-id="diag-1"]');
    await pressKey(sel, "Enter");

    const isSelected = await browser.execute((s: string) => {
      const el = document.querySelector<HTMLElement>(s);
      return el?.classList.contains("vc-canvas-node-selected") ?? false;
    }, sel);
    expect(isSelected).toBe(true);
  });

  it("Enter on an edge label enters edit mode", async () => {
    const sel = await vizSel(" .vc-canvas-edge-label");
    const prevented = await pressKey(sel, "Enter");
    expect(prevented).toBe(true);

    // Edit mode unmounts the `.vc-canvas-edge-label` div and mounts a
    // `.vc-canvas-edge-label-input` in its place. The label div going away
    // and the input appearing together prove the handler ran the
    // editingEdgeId = edge.id branch.
    const inputSel = await vizSel(" .vc-canvas-edge-label-input");
    const input = await browser.$(inputSel);
    await input.waitForDisplayed({ timeout: 3000 });
  });
});
