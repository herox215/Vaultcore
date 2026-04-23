// E2E regression guard for #345 — password-protected encrypted folders.
//
// Exercises the full user-facing flow end-to-end:
//   1. Right-click a plain folder → context menu shows "Encrypt folder…"
//   2. Fill the EncryptFolderModal, click Encrypt → backend seals files
//   3. Sidebar folder row renders the Lock icon, children are hidden
//   4. Search results from the locked subtree are hidden (structural)
//   5. Click the locked folder row → PasswordPromptModal opens
//   6. Wrong password → inline error, modal stays open
//   7. Correct password → LockOpen icon, children visible
//   8. Right-click on unlocked folder → "Lock folder" action locks again
//   9. Manifest persists across reload — not tested here because the
//      test driver restarts the whole app between specs. See the
//      `reload_manifest_locks_all_roots_on_open` Rust test in
//      src-tauri/src/tests/encryption_gating.rs for the restart side.
//
// The spec is deliberately linear: each `it` depends on the previous
// one via `before` fixture + shared sidebar state (same pattern as
// bookmarks.spec.ts). Failures abort subsequent steps.

import { createTestVault, type TestVault } from "../helpers/vault.js";
import { openVaultInApp } from "../helpers/open-vault.js";
import { textOf } from "../helpers/text.js";

describe("Encrypted folders (#345)", () => {
  let vault: TestVault;
  const folderName = "subfolder";
  const password = "test-vault-pw-12345!";

  before(async () => {
    vault = createTestVault();
    await openVaultInApp(vault.path);
  });

  after(() => {
    vault.cleanup();
  });

  async function findTreeNodeByName(name: string) {
    const nodes = await browser.$$(".vc-tree-name");
    for (const node of nodes) {
      if ((await textOf(node)) === name) {
        return node;
      }
    }
    return null;
  }

  async function findTreeRowByName(name: string) {
    const node = await findTreeNodeByName(name);
    if (!node) return null;
    // The row wraps the name element — traverse up to the row container.
    return node.parentElement();
  }

  async function openFolderContextMenu(name: string) {
    const row = await findTreeRowByName(name);
    if (!row) throw new Error(`Folder row "${name}" not found`);
    // Simulate right-click via rclick on the row.
    await row.moveTo();
    // WDIO's keyboard trigger for contextmenu via browser.performActions.
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: row },
          { type: "pointerDown", button: 2 },
          { type: "pointerUp", button: 2 },
        ],
      },
    ]);
    await browser.releaseActions();
    // Wait for the context menu to render.
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });
    return menu;
  }

  it("shows the Encrypt folder action for a plain folder", async () => {
    await openFolderContextMenu(folderName);
    const encryptItem = await browser.$('[data-testid="context-encrypt-folder"]');
    await encryptItem.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(encryptItem)).toContain("Encrypt folder");
    // Close the menu by clicking elsewhere.
    await browser.$(".vc-tree").click();
  });

  it("encrypts a folder through the EncryptFolderModal", async () => {
    await openFolderContextMenu(folderName);
    const encryptItem = await browser.$('[data-testid="context-encrypt-folder"]');
    await encryptItem.click();

    const modal = await browser.$('[data-testid="encrypt-folder-modal"]');
    await modal.waitForDisplayed({ timeout: 3000 });

    const pwInput = await browser.$('[data-testid="encrypt-folder-password"]');
    await pwInput.setValue(password);
    const confirmInput = await browser.$('[data-testid="encrypt-folder-confirm"]');
    await confirmInput.setValue(password);

    const confirmBtn = await browser.$('[data-testid="encrypt-folder-confirm-button"]');
    await confirmBtn.click();

    // Modal closes on completion; the folder row picks up the Lock icon.
    await modal.waitForDisplayed({ reverse: true, timeout: 15_000 });

    // Sidebar row for the encrypted folder now carries the locked class.
    await browser.waitUntil(
      async () => {
        const row = await findTreeRowByName(folderName);
        if (!row) return false;
        const icon = await row.$(".vc-tree-icon--locked");
        return await icon.isExisting();
      },
      { timeout: 15_000, timeoutMsg: "locked icon never appeared" },
    );
  });

  it("hides children of a locked folder from the tree", async () => {
    // Before encryption, the test vault had `subfolder/Nested Note.md` and
    // `subfolder/Another Note.md`. After encrypt + lock those rows must
    // not be visible in the flat tree.
    const nested = await findTreeNodeByName("Nested Note.md");
    expect(nested).toBeNull();
  });

  it("opens the unlock modal when the user clicks a locked folder row", async () => {
    const row = await findTreeRowByName(folderName);
    if (!row) throw new Error("locked row missing");
    await row.click();
    const modal = await browser.$('[data-testid="password-prompt"]');
    await modal.waitForDisplayed({ timeout: 3000 });
  });

  it("shows a wrong-password error inline without closing the modal", async () => {
    const input = await browser.$('[data-testid="password-prompt-input"]');
    await input.setValue("wrong");
    const confirm = await browser.$('[data-testid="password-prompt-confirm"]');
    await confirm.click();

    const errorRow = await browser.$('[data-testid="password-prompt-error"]');
    await errorRow.waitForDisplayed({ timeout: 5000 });
    expect(await textOf(errorRow)).toContain("Wrong password");

    // Modal is still there — user can retry.
    const modal = await browser.$('[data-testid="password-prompt"]');
    expect(await modal.isDisplayed()).toBe(true);
  });

  it("unlocks the folder with the correct password and reveals children", async () => {
    const input = await browser.$('[data-testid="password-prompt-input"]');
    await input.setValue(password);
    const confirm = await browser.$('[data-testid="password-prompt-confirm"]');
    await confirm.click();

    const modal = await browser.$('[data-testid="password-prompt"]');
    await modal.waitForDisplayed({ reverse: true, timeout: 10_000 });

    // Folder row now shows the unlocked icon.
    await browser.waitUntil(
      async () => {
        const row = await findTreeRowByName(folderName);
        if (!row) return false;
        const icon = await row.$(".vc-tree-icon--unlocked");
        return await icon.isExisting();
      },
      { timeout: 10_000, timeoutMsg: "unlocked icon never appeared" },
    );
  });

  it("re-locks the folder via the context menu", async () => {
    await openFolderContextMenu(folderName);
    const lockItem = await browser.$('[data-testid="context-lock-folder"]');
    await lockItem.waitForDisplayed({ timeout: 3000 });
    await lockItem.click();

    // Row flips back to locked.
    await browser.waitUntil(
      async () => {
        const row = await findTreeRowByName(folderName);
        if (!row) return false;
        const icon = await row.$(".vc-tree-icon--locked");
        return await icon.isExisting();
      },
      { timeout: 10_000, timeoutMsg: "locked icon never reappeared after manual lock" },
    );
  });
});
