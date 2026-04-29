// Issue #358 PR C — guard against silent class-rename drift between the
// WDIO ASCII-aesthetic smoke spec and the components it queries.
//
// Aristotle PR-C round 1 caught a real bug: the spec used
// `.vc-encryption-statusbar` (which doesn't exist) so the encryption-pill
// geometry assertion silently never ran. This test reads the spec + the
// referenced source files and asserts the selectors map onto class names
// that actually exist. A future rename in either direction will fail
// fast at unit-test time instead of months later in WDIO.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const SPEC = readFileSync(
  resolve(REPO_ROOT, "e2e/specs/ascii-aesthetic.spec.ts"),
  "utf8",
);
const ENCRYPTION_STATUSBAR = readFileSync(
  resolve(REPO_ROOT, "src/components/Statusbar/EncryptionStatusbar.svelte"),
  "utf8",
);
const WELCOME_SCREEN = readFileSync(
  resolve(REPO_ROOT, "src/components/Welcome/WelcomeScreen.svelte"),
  "utf8",
);
const VAULT_LAYOUT = readFileSync(
  resolve(REPO_ROOT, "src/components/Layout/VaultLayout.svelte"),
  "utf8",
);
const EDITOR_PANE = readFileSync(
  resolve(REPO_ROOT, "src/components/Editor/EditorPane.svelte"),
  "utf8",
);

describe("ASCII aesthetic WDIO spec selectors (#358)", () => {
  it("the encryption-pill selector matches the actual class in EncryptionStatusbar.svelte", () => {
    // The spec references the pill so the geometry no-overlap check
    // can run when an encrypted folder exists.
    expect(SPEC).toContain(".vc-encrypt-bar");
    expect(SPEC).not.toContain(".vc-encryption-statusbar");
    // And the class itself is declared in the source file.
    expect(ENCRYPTION_STATUSBAR).toMatch(/class="vc-encrypt-bar"/);
  });

  it("the wordmark selector matches WelcomeScreen.svelte", () => {
    expect(SPEC).toContain("pre.vc-welcome-wordmark");
    expect(WELCOME_SCREEN).toMatch(/class="vc-welcome-wordmark"/);
  });

  it("the statusbar accent selector matches VaultLayout.svelte", () => {
    expect(SPEC).toContain(".vc-statusbar-accent");
    expect(VAULT_LAYOUT).toMatch(/class="vc-statusbar-accent"/);
  });

  it("the editor empty-state door selector matches EditorPane.svelte", () => {
    expect(SPEC).toContain("pre.vc-editor-empty-door");
    expect(EDITOR_PANE).toMatch(/class="vc-editor-empty-door"/);
  });
});
