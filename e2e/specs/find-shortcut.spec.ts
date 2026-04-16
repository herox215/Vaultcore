import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";

/**
 * VaultCore has no in-editor find/replace (CodeMirror @codemirror/search is
 * not wired up). The Cmd+F shortcut is registered as an alias of fulltext
 * search — it activates the left-sidebar Search tab. This spec covers the
 * alias path specifically; the primary Ctrl+Shift+F shortcut is covered by
 * search.spec.ts.
 */
describe("Find shortcut (Ctrl+F alias)", () => {
  let vault: TestVault;

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  it("activates the search sidebar when Ctrl+F is pressed", async () => {
    await browser.keys(["Control", "f"]);

    const input = await browser.$('.vc-search-input, [role="searchbox"]');
    await input.waitForDisplayed({ timeout: 3000 });
  });
});
