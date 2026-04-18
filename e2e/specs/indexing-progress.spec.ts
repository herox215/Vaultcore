import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

/**
 * The real indexing overlay appears when the Rust backend emits the
 * `vault://index_progress` event during a vault scan. On a small fixture
 * vault the scan completes in milliseconds — far too short to observe the
 * overlay deterministically. Instead we drive progressStore via the
 * __e2e__ hook, which exercises the same rendering pipeline the production
 * indexer triggers.
 */
describe("Indexing progress overlay", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function startProgress(total: number): Promise<void> {
    await browser.execute((t: number) => {
      window.__e2e__!.startProgress(t);
    }, total);
  }

  async function updateProgress(current: number, total: number, file: string): Promise<void> {
    await browser.execute(
      (c: number, t: number, f: string) => {
        window.__e2e__!.updateProgress(c, t, f);
      },
      current,
      total,
      file,
    );
  }

  async function finishProgress(): Promise<void> {
    await browser.execute(() => {
      window.__e2e__!.finishProgress();
    });
  }

  it("renders the progress overlay when indexing starts", async () => {
    await startProgress(100);
    await updateProgress(10, 100, "notes/a.md");

    const overlay = await browser.$('[data-testid="progress-overlay"]');
    await overlay.waitForDisplayed({ timeout: 3000 });

    const bar = await browser.$('[role="progressbar"]');
    expect(await bar.isDisplayed()).toBe(true);
  });

  it("updates the counter and bar width as indexing advances", async () => {
    await updateProgress(42, 100, "notes/foo.md");

    const counter = await browser.$('[data-testid="progress-counter"]');
    await browser.waitUntil(
      async () => {
        const txt = ((await counter.getProperty("textContent")) as string).replace(/[.,\s]/g, "");
        return txt.includes("42") && txt.includes("100");
      },
      { timeout: 2000, timeoutMsg: "Progress counter never updated to 42 / 100" },
    );

    const fill = await browser.$('[data-testid="progress-fill"]');
    const widthStyle = (await fill.getAttribute("style")) ?? "";
    // The fill uses width: N%; at 42/100 the CSS should hold a number
    // between ~40 and ~45 so the bar visibly reflects progress.
    expect(/width:\s*4[0-9](\.\d+)?%/.test(widthStyle)).toBe(true);
  });

  it("closes the overlay when indexing finishes", async () => {
    await finishProgress();
    await browser.$('[data-testid="progress-overlay"]').waitForDisplayed({ timeout: 3000, reverse: true });
  });
});
