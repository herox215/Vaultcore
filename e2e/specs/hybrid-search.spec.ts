import fs from "node:fs";
import path from "node:path";
import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

// #204 AC-4: the OmniSearch content mode routes through hybrid_search, so
// a query whose keywords do NOT appear in any note can still surface a
// semantically-related note via the HNSW leg. This spec seeds a vault
// with a note whose content talks about felines (without using the word
// "cat"), waits for the embedding pass to finish, then asserts that a
// search for "cat" returns the note AND that the semantic-only indicator
// renders on the row — the indicator is the only reliable proof that the
// vec leg fired instead of a BM25 fallback.
describe("Hybrid search surfaces semantic-only notes", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    // Seed a note whose content is semantically close to "cat" but shares
    // no keywords — MiniLM maps pet / feline prose into the same region
    // as the query "cat", so the RRF vec leg should surface it.
    fs.writeFileSync(
      path.join(vault.path, "Feline Ode.md"),
      [
        "# Feline Ode",
        "",
        "The soft purr of a small tiger nestled in a sunbeam.",
        "Whiskers twitching, a tiny predator of dust motes.",
        "Kittens chase shadows across polished floors.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await openVaultInApp(vault.path);

    // Run an initial embedding pass over the fixture vault and wait for
    // the terminal `done` event. Generous timeout covers ORT session
    // warmup on first call (the long pole — typically 200–800ms but can
    // spike on cold machines).
    await browser.executeAsync((done: (err?: string) => void) => {
      const hook = window.__e2e__;
      if (!hook) {
        done("window.__e2e__ hook missing");
        return;
      }
      void hook
        .reindexAndWaitDone()
        .then(() => done())
        .catch((e: unknown) => done(String(e)));
    });
  });

  after(() => {
    vault.cleanup();
  });

  async function openContentSearch(): Promise<WebdriverIO.Element> {
    await browser.keys(["Control", "Shift", "f"]);
    const modal = await browser.$(".vc-quick-switcher-modal");
    await modal.waitForDisplayed({ timeout: 3000 });
    return browser.$(".vc-qs-input");
  }

  async function closeOmni(): Promise<void> {
    await browser.keys(["Escape"]);
    await browser
      .$(".vc-quick-switcher-modal")
      .waitForDisplayed({ timeout: 2000, reverse: true });
  }

  it("surfaces a semantically related note that contains none of the query terms", async () => {
    const input = await openContentSearch();
    await input.click();
    // "cat" — not present in Feline Ode.md or any other fixture file.
    await input.setValue("cat");
    // Pass the 200ms debounce plus some slack for embed+query.
    await browser.pause(600);

    const rows = await browser.$$(".vc-search-result-row");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const filenames: string[] = [];
    for (const row of rows) {
      filenames.push(await textOf(await row.$(".vc-search-result-filename")));
    }
    expect(filenames.some((f) => f.includes("Feline Ode"))).toBe(true);

    // The indicator only renders when `vecRank != null && bm25Rank == null`,
    // which is exactly the "surfaced by the semantic leg alone" case. Its
    // presence is the sharpest E2E-visible signal that hybrid_search did
    // more than fall back to BM25-only.
    const indicator = await browser.$(".vc-search-result-semantic-indicator");
    await indicator.waitForDisplayed({ timeout: 2000 });
    expect(await indicator.getAttribute("aria-label")).toMatch(/semantisch/i);

    await closeOmni();
  });
});
