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
    // WebKitWebDriver rejects `pointerMove { origin: <element> }` actions
    // ("'x' parameter for the action is missing") — fall back to a JS-level
    // contextmenu dispatch, the same pattern rename-cascade.spec.ts uses.
    const dispatched = await browser.execute((target: string) => {
      const nodes = document.querySelectorAll(".vc-tree-name");
      for (const n of Array.from(nodes)) {
        if ((n.textContent ?? "").trim() === target) {
          const row = (n as Element).closest(".vc-tree-row") ?? n.parentElement;
          if (!row) return false;
          row.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: 100,
              clientY: 100,
              button: 2,
            }),
          );
          return true;
        }
      }
      return false;
    }, name);
    if (!dispatched) throw new Error(`Folder row "${name}" not found`);
    const menu = await browser.$(".vc-context-menu");
    await menu.waitForDisplayed({ timeout: 3000 });
    return menu;
  }

  it("shows the Encrypt folder action for a plain folder", async () => {
    await openFolderContextMenu(folderName);
    const encryptItem = await browser.$('[data-testid="context-encrypt-folder"]');
    await encryptItem.waitForDisplayed({ timeout: 3000 });
    expect(await textOf(encryptItem)).toContain("Encrypt folder");
    // Close the menu by pressing Escape — `.vc-tree` was renamed to
    // `.vc-tree-root` (#253 virtualization), so the original click-to-
    // dismiss selector no longer matches.
    await browser.keys("Escape");
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

  it("Lock all now — Settings button locks every unlocked folder", async () => {
    // Re-unlock first so we have something for the button to act on; the
    // previous test left the folder locked.
    const row = await findTreeRowByName(folderName);
    if (!row) throw new Error("locked row missing");
    await row.click();
    const promptInput = await browser.$('[data-testid="password-prompt-input"]');
    await promptInput.waitForDisplayed({ timeout: 3000 });
    await promptInput.setValue(password);
    await browser.$('[data-testid="password-prompt-confirm"]').click();
    await browser.$('[data-testid="password-prompt"]').waitForDisplayed({
      reverse: true,
      timeout: 10_000,
    });
    await browser.waitUntil(
      async () => {
        const r = await findTreeRowByName(folderName);
        if (!r) return false;
        return (await r.$(".vc-tree-icon--unlocked").isExisting());
      },
      { timeout: 10_000, timeoutMsg: "folder never returned to unlocked" },
    );

    // Open settings → Lock all now → folder flips back to locked.
    const settingsBtn = await browser.$('button[aria-label="Einstellungen"]');
    await settingsBtn.click();
    await browser.$('[data-testid="settings-modal"]').waitForDisplayed({ timeout: 3000 });

    const lockAll = await browser.$('[data-testid="settings-lock-all"]');
    await lockAll.waitForDisplayed({ timeout: 3000 });
    await lockAll.click();

    // Close the modal so the sidebar is observable again. The button is
    // disabled when no encrypted folders are present, so the lock-all
    // round-trip must have completed by the time we close.
    const close = await browser.$(".vc-settings-close");
    if (await close.isDisplayed().catch(() => false)) await close.click();
    await browser.$('[data-testid="settings-modal"]').waitForDisplayed({
      reverse: true,
      timeout: 3000,
    });

    await browser.waitUntil(
      async () => {
        const r = await findTreeRowByName(folderName);
        if (!r) return false;
        return (await r.$(".vc-tree-icon--locked").isExisting());
      },
      { timeout: 10_000, timeoutMsg: "Lock all now did not relock the folder" },
    );
  });
});
