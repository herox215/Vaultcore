import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf, textsOf } from "../helpers/text.js";

/**
 * #62 — block references and heading anchors, end-to-end.
 *
 * Coverage:
 *   - resolved block-ref click opens target + applies the flash highlight
 *   - resolved heading-ref (multi-word slug) opens target + applies flash
 *   - anchor-missing click opens target + surfaces a `warning` toast and
 *     decorates the link with `cm-wikilink-unresolved-anchor`
 *   - heading-section embed renders only the section body (the H3 inside
 *     the section is present, the next H2's body is not)
 *   - block embed renders only the tagged paragraph (not the rest of
 *     the source file)
 */
describe("Block references (#62)", () => {
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

  async function waitForVisibleEditor(): Promise<void> {
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-content");
        for (const el of els) if (await el.isDisplayed()) return true;
        return false;
      },
      { timeout: 5000, timeoutMsg: ".cm-content never became visible" },
    );
  }

  async function waitForDecoration(selector: string, msg: string): Promise<void> {
    await browser.waitUntil(
      async () => (await browser.$$(selector)).length > 0,
      { timeout: 5000, timeoutMsg: msg },
    );
  }

  /**
   * Click a wiki-link decoration matching `target` and (optionally) the
   * given `data-wiki-anchor-value`. The CM6 plugin handles `mousedown`,
   * not `click`, so we dispatch a real `mousedown` event.
   */
  async function clickWikiLink(
    target: string,
    anchorValue?: string,
  ): Promise<boolean> {
    return browser.execute(
      (t: string, a: string | undefined) => {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>("[data-wiki-target]"),
        );
        const match = nodes.find((el) => {
          if (el.getAttribute("data-wiki-target") !== t) return false;
          if (a !== undefined) {
            return el.getAttribute("data-wiki-anchor-value") === a;
          }
          return true;
        });
        if (!match) return false;
        match.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
        );
        return true;
      },
      target,
      anchorValue,
    );
  }

  it("resolves a block-ref click and flashes the target paragraph", async () => {
    await openTreeFile("Anchor Refs.md");
    await waitForVisibleEditor();
    await waitForDecoration(
      ".cm-wikilink-resolved",
      ".cm-wikilink-resolved never rendered",
    );

    const clicked = await clickWikiLink("Anchored", "recap");
    expect(clicked).toBe(true);

    // Anchored.md tab opens.
    await browser.waitUntil(
      async () => {
        const titles = await textsOf(await browser.$$(".vc-tab-label"));
        return titles.some((t) => t.includes("Anchored"));
      },
      { timeout: 3000, timeoutMsg: "Anchored tab never opened" },
    );

    // Flash decoration appears on the target range.
    await browser.waitUntil(
      async () => (await browser.$$(".vc-flash-highlight")).length > 0,
      {
        timeout: 3000,
        timeoutMsg: ".vc-flash-highlight never appeared after anchor scroll",
      },
    );
  });

  it("resolves a multi-word heading-ref via the slug", async () => {
    await openTreeFile("Anchor Refs.md");
    await waitForVisibleEditor();
    await waitForDecoration(
      ".cm-wikilink-resolved",
      ".cm-wikilink-resolved never rendered",
    );

    // The decoration's data-wiki-anchor-value preserves the raw value
    // ("Multi Word Heading"); the slug step happens inside resolveAnchor.
    const clicked = await clickWikiLink("Anchored", "Multi Word Heading");
    expect(clicked).toBe(true);

    await browser.waitUntil(
      async () => (await browser.$$(".vc-flash-highlight")).length > 0,
      {
        timeout: 3000,
        timeoutMsg: "heading-ref scroll did not flash the target",
      },
    );
  });

  it("renders missing anchors with the warning class and shows a toast on click", async () => {
    await openTreeFile("Anchor Refs.md");
    await waitForVisibleEditor();
    await waitForDecoration(
      ".cm-wikilink-unresolved-anchor",
      ".cm-wikilink-unresolved-anchor never rendered",
    );

    const clicked = await clickWikiLink("Anchored", "does-not-exist");
    expect(clicked).toBe(true);

    // Warning toast surfaces with a message containing the anchor label.
    await browser.waitUntil(
      async () => {
        const toasts = await browser.$$('[data-testid="toast"][data-variant="warning"]');
        for (const t of toasts) {
          const text = await textOf(t);
          if (text.includes("does-not-exist")) return true;
        }
        return false;
      },
      {
        timeout: 3000,
        timeoutMsg: "warning toast for missing anchor never appeared",
      },
    );
  });

  it("renders a heading-section embed scoped to the section body only", async () => {
    await openTreeFile("Anchor Refs.md");
    await waitForVisibleEditor();

    // Wait for at least one note-embed widget to render.
    await browser.waitUntil(
      async () => (await browser.$$(".cm-embed-note")).length > 0,
      {
        timeout: 5000,
        timeoutMsg: ".cm-embed-note never rendered",
      },
    );

    // Find the embed whose data-embed-path is Anchored.md AND that contains
    // the multi-word heading text — there are two embeds in this file
    // (heading + block) so we filter by content.
    const sectionText = await browser.execute(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(".cm-embed-note"));
      for (const n of nodes) {
        if (n.getAttribute("data-embed-path") !== "Anchored.md") continue;
        const t = n.textContent ?? "";
        if (t.includes("Multi Word Heading")) return t;
      }
      return "";
    });

    expect(sectionText).toContain("Multi Word Heading");
    expect(sectionText).toContain("Nested H3 inside Multi Word");
    // Section embed must STOP at the next H2 — Düsseldorf and Final
    // section are subsequent H2s and must not bleed in.
    expect(sectionText).not.toContain("Düsseldorf trip");
    expect(sectionText).not.toContain("Final section");
  });

  it("renders a block embed scoped to the tagged paragraph only", async () => {
    await openTreeFile("Anchor Refs.md");
    await waitForVisibleEditor();

    await browser.waitUntil(
      async () => (await browser.$$(".cm-embed-note")).length >= 2,
      {
        timeout: 5000,
        timeoutMsg: "expected two .cm-embed-note widgets",
      },
    );

    const blockText = await browser.execute(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(".cm-embed-note"));
      for (const n of nodes) {
        if (n.getAttribute("data-embed-path") !== "Anchored.md") continue;
        const t = n.textContent ?? "";
        // Block embed contains the recap line but not the heading.
        if (t.includes("recap paragraph") && !t.includes("Multi Word Heading")) {
          return t;
        }
      }
      return "";
    });

    expect(blockText).toContain("recap paragraph");
    // Other sections of Anchored.md must not leak into the block embed.
    expect(blockText).not.toContain("Multi Word Heading");
    expect(blockText).not.toContain("Final section");
  });
});
