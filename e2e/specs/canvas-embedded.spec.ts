import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * E2E coverage for issue #126 (canvas phase 3 — embedded nodes). Tests:
 *   - File (markdown) nodes show the rendered preview pulled from disk.
 *   - File (image) nodes render as `<img>` with a working convertFileSrc URL.
 *   - Link nodes render a URL card with an Open control.
 *   - Group nodes render as a translucent labelled container behind other nodes.
 *   - Clicking a markdown file node's "Open" opens it in the editor pane.
 *   - Clicking an image file node's "Open" opens the image tab.
 *   - Clicking a link node's "Open" invokes window.open with the URL.
 *   - Roundtrip: editing the canvas preserves file.subpath, link unknown
 *     fields, and group background/style passthrough.
 *   - Corrupt / unknown node types do not crash the viewer.
 */

const DEBOUNCE_MS = 400;
const FLUSH_WAIT_MS = DEBOUNCE_MS + 500;

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const NOTE_MD = `---
title: Embedded note
tags: [canvas, embed]
---
# Einbettung

Dieser Text ist der **Vorschau-Body** aus dem eingebetteten Note.

- Punkt eins
- Punkt zwei
`;

const EMBEDDED_DOC = {
  nodes: [
    {
      id: "text-a",
      type: "text",
      x: -400,
      y: -200,
      width: 180,
      height: 60,
      text: "Hallo",
    },
    {
      id: "file-md-1",
      type: "file",
      x: -180,
      y: -220,
      width: 320,
      height: 200,
      file: "Embedded Note.md",
      subpath: "#Einbettung",
      futureFileField: { kept: true },
    },
    {
      id: "file-img-1",
      type: "file",
      x: 180,
      y: -220,
      width: 160,
      height: 160,
      file: "attachments/dot.png",
    },
    {
      id: "link-1",
      type: "link",
      x: -180,
      y: 40,
      width: 320,
      height: 80,
      url: "https://example.com/vaultcore",
      unknownLinkField: "stays",
    },
    {
      id: "group-1",
      type: "group",
      x: -420,
      y: -260,
      width: 820,
      height: 520,
      label: "Gruppe A",
      background: "attachments/dot.png",
      backgroundStyle: "cover",
      futureGroupField: 99,
    },
    {
      id: "unknown-1",
      type: "diagram",
      x: 180,
      y: 40,
      width: 160,
      height: 80,
      weirdField: 1,
    },
  ],
  edges: [],
  metadata: { topLevel: "kept" },
};

describe("Canvas embedded nodes (#126)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    // Note body for the markdown-file node.
    fs.writeFileSync(
      path.join(vault.path, "Embedded Note.md"),
      NOTE_MD,
      "utf-8",
    );
    // Image for the file-image node.
    fs.writeFileSync(path.join(vault.path, "attachments", "dot.png"), PNG_1PX);
    fs.writeFileSync(
      path.join(vault.path, "Embedded.canvas"),
      JSON.stringify(EMBEDDED_DOC, null, "\t"),
      "utf-8",
    );
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  // ─── Helpers ──────────────────────────────────────────────────────────

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

  async function readDisk(name: string): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    [k: string]: unknown;
  }> {
    const raw = fs.readFileSync(path.join(vault.path, name), "utf-8");
    return JSON.parse(raw);
  }

  async function waitForDiskDoc<T>(
    name: string,
    predicate: (doc: {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      [k: string]: unknown;
    }) => T | null | false | undefined,
    timeoutMs = FLUSH_WAIT_MS * 8,
  ): Promise<T> {
    const start = Date.now();
    let last: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        const doc = await readDisk(name);
        const hit = predicate(doc);
        if (hit) return hit as T;
        last = doc;
      } catch {
        /* file not yet written */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `waitForDiskDoc(${name}) timed out. Last doc: ${JSON.stringify(last)}`,
    );
  }

  async function pointerClick(sel: string): Promise<void> {
    await browser.execute((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) throw new Error(`No element: ${s}`);
      const r = el.getBoundingClientRect();
      const opts: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        pointerId: 7,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          button: 0,
        }),
      );
    }, sel);
  }

  // ─── Tests ────────────────────────────────────────────────────────────

  it("renders text, file-md, file-image, link, group and unknown nodes", async () => {
    await openTreeFile("Embedded.canvas");
    await waitForCanvas();

    const vp = await vizSel();
    // Wait until every expected node type has mounted.
    await browser.waitUntil(
      async () => {
        const counts = await browser.execute((sel: string) => {
          const v = document.querySelector(sel);
          if (!v) return null;
          return {
            text: v.querySelectorAll(".vc-canvas-node-text").length,
            file: v.querySelectorAll(".vc-canvas-node-file").length,
            link: v.querySelectorAll(".vc-canvas-node-link").length,
            group: v.querySelectorAll(".vc-canvas-node-group").length,
            placeholder: v.querySelectorAll(".vc-canvas-node-placeholder")
              .length,
          };
        }, vp);
        if (!counts) return false;
        return (
          counts.text === 1 &&
          counts.file === 2 &&
          counts.link === 1 &&
          counts.group === 1 &&
          counts.placeholder === 1
        );
      },
      { timeout: 8000, timeoutMsg: "Not all node variants mounted" },
    );
  });

  it("file-image node renders an <img> whose src uses the asset: protocol", async () => {
    const vp = await vizSel();
    await browser.waitUntil(
      async () => {
        const src = await browser.execute((sel: string) => {
          const img = document.querySelector<HTMLImageElement>(
            `${sel} [data-node-id="file-img-1"] img[data-canvas-image="true"]`,
          );
          return img?.src ?? null;
        }, vp);
        return typeof src === "string" && src.length > 0;
      },
      { timeout: 5000, timeoutMsg: "Image node never got a src" },
    );

    const src = (await browser.execute((sel: string) => {
      const img = document.querySelector<HTMLImageElement>(
        `${sel} [data-node-id="file-img-1"] img[data-canvas-image="true"]`,
      );
      return img?.src ?? "";
    }, vp)) as string;

    // convertFileSrc uses the asset:// (or http://asset.localhost) protocol.
    expect(src).toMatch(/^(asset:\/\/|http:\/\/asset\.localhost)/);
    // The image's vault-relative path is part of the URL.
    expect(src).toContain("dot.png");
  });

  it("file-md node shows the rendered markdown preview", async () => {
    const vp = await vizSel();
    await browser.waitUntil(
      async () => {
        const html = await browser.execute((sel: string) => {
          const el = document.querySelector(
            `${sel} [data-node-id="file-md-1"] .vc-canvas-node-md`,
          ) as HTMLElement | null;
          return el?.innerHTML ?? "";
        }, vp);
        // Frontmatter must be stripped; headings + list items should appear.
        return (
          typeof html === "string" &&
          html.includes("<h1") &&
          html.includes("Einbettung") &&
          !html.includes("title: Embedded note")
        );
      },
      { timeout: 8000, timeoutMsg: "Markdown preview never rendered" },
    );
  });

  it("group node renders with its label", async () => {
    const vp = await vizSel();
    const label = (await browser.execute((sel: string) => {
      const el = document.querySelector(
        `${sel} [data-node-id="group-1"] .vc-canvas-node-group-label`,
      ) as HTMLElement | null;
      return el?.textContent?.trim() ?? "";
    }, vp)) as string;
    expect(label).toBe("Gruppe A");
  });

  it("link node shows its URL and an Open control", async () => {
    const vp = await vizSel();
    const [urlText, btnCount] = (await browser.execute((sel: string) => {
      const host = document.querySelector(
        `${sel} [data-node-id="link-1"]`,
      ) as HTMLElement | null;
      const url = host?.querySelector<HTMLElement>(
        ".vc-canvas-node-link-url",
      );
      const btn = host?.querySelectorAll<HTMLButtonElement>(
        '[data-canvas-open="link"]',
      );
      return [url?.textContent?.trim() ?? "", btn?.length ?? 0];
    }, vp)) as [string, number];
    expect(urlText).toBe("https://example.com/vaultcore");
    expect(btnCount).toBe(1);
  });

  it("clicking Open on the markdown file node opens it as a tab", async () => {
    const vp = await vizSel();
    const sel = `${vp} [data-node-id="file-md-1"] [data-canvas-open="md"]`;
    await pointerClick(sel);

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const tabs = Array.from(
            document.querySelectorAll<HTMLElement>(".vc-tab-title, .vc-tab"),
          );
          return tabs.some((t) =>
            (t.textContent ?? "").includes("Embedded Note"),
          );
        }),
      { timeout: 5000, timeoutMsg: "Embedded Note tab never appeared" },
    );
  });

  it("clicking Open on the image file node opens the image tab", async () => {
    // Re-activate the canvas tab (previous test swapped to the note tab).
    await openTreeFile("Embedded.canvas");
    await waitForCanvas();

    const vp = await vizSel();
    const sel = `${vp} [data-node-id="file-img-1"] [data-canvas-open="image"]`;
    await pointerClick(sel);

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const tabs = Array.from(
            document.querySelectorAll<HTMLElement>(".vc-tab-title, .vc-tab"),
          );
          return tabs.some((t) => (t.textContent ?? "").includes("dot.png"));
        }),
      { timeout: 5000, timeoutMsg: "dot.png tab never appeared" },
    );
  });

  it("clicking Open on the link node calls window.open with the URL", async () => {
    // Re-open canvas (prior tests may have switched tabs).
    await openTreeFile("Embedded.canvas");
    await waitForCanvas();

    const vp = await vizSel();
    const sel = `${vp} [data-node-id="link-1"] [data-canvas-open="link"]`;

    // Install a window.open spy that records calls on a global.
    await browser.execute(() => {
      (window as unknown as { __openCalls: string[] }).__openCalls = [];
      const orig = window.open.bind(window);
      window.open = ((url?: string | URL) => {
        (window as unknown as { __openCalls: string[] }).__openCalls.push(
          String(url ?? ""),
        );
        return null;
      }) as typeof window.open;
      (window as unknown as { __origOpen: typeof window.open }).__origOpen =
        orig;
    });

    await pointerClick(sel);

    const calls = (await browser.execute(() => {
      return (
        (window as unknown as { __openCalls?: string[] }).__openCalls ?? []
      );
    })) as string[];

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toBe("https://example.com/vaultcore");
  });

  it("roundtrip preserves file.subpath, link unknown fields, and group background", async () => {
    // Re-open the canvas and trigger an autosave by nudging the text node.
    await openTreeFile("Embedded.canvas");
    await waitForCanvas();

    const vp = await vizSel();

    // Simulate a small move of the text node (top-left corner) so the doc
    // gets rewritten through the same serialization path.
    await browser.execute((sel: string) => {
      const el = document.querySelector(
        `${sel} [data-node-id="text-a"]`,
      ) as HTMLElement | null;
      if (!el) throw new Error("text-a node missing");
      const r = el.getBoundingClientRect();
      const mk = (x: number, y: number): PointerEventInit => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        pointerId: 31,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        isPrimary: true,
      });
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent("pointerdown", mk(cx, cy)));
      const vps = Array.from(
        document.querySelectorAll<HTMLElement>(".vc-canvas-viewport"),
      );
      const visible = vps.find((v) => v.offsetParent !== null);
      visible?.dispatchEvent(
        new PointerEvent("pointermove", mk(cx + 20, cy + 10)),
      );
      visible?.dispatchEvent(new PointerEvent("pointerup", mk(cx + 20, cy + 10)));
    }, vp);

    await waitForDiskDoc("Embedded.canvas", (doc) => {
      const byId = new Map(
        (doc.nodes as Array<Record<string, unknown>>).map((n) => [
          n.id as string,
          n,
        ]),
      );
      const file = byId.get("file-md-1");
      const link = byId.get("link-1");
      const group = byId.get("group-1");
      const unknown = byId.get("unknown-1");
      if (!file || !link || !group || !unknown) return false;
      const topLevelOk = doc.metadata &&
        (doc.metadata as { topLevel?: string }).topLevel === "kept";
      return (
        topLevelOk &&
        file.subpath === "#Einbettung" &&
        (file.futureFileField as { kept?: boolean } | undefined)?.kept === true &&
        link.unknownLinkField === "stays" &&
        group.background === "attachments/dot.png" &&
        group.backgroundStyle === "cover" &&
        group.futureGroupField === 99 &&
        unknown.type === "diagram" &&
        unknown.weirdField === 1
      );
    });
  });
});
