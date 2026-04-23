// #345 — modal controller store. Tests the open/close/error helpers.

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";

import {
  closeEncryptionModal,
  encryptionModal,
  openEncryptModal,
  openUnlockModal,
  setEncryptionModalError,
} from "../encryptionModalStore";

describe("encryptionModalStore", () => {
  beforeEach(() => {
    closeEncryptionModal();
  });

  it("starts closed", () => {
    expect(get(encryptionModal)).toBeNull();
  });

  it("opens the encrypt modal", () => {
    openEncryptModal("/vault/secret", "secret");
    const m = get(encryptionModal);
    expect(m?.kind).toBe("encrypt");
    if (m?.kind === "encrypt") {
      expect(m.folderPath).toBe("/vault/secret");
      expect(m.folderLabel).toBe("secret");
    }
  });

  it("opens the unlock modal with optional onUnlocked callback", () => {
    let called = 0;
    openUnlockModal("/vault/secret", "secret", () => {
      called += 1;
    });
    const m = get(encryptionModal);
    expect(m?.kind).toBe("unlock");
    if (m?.kind === "unlock") {
      m.onUnlocked?.();
      expect(called).toBe(1);
    }
  });

  it("omits onUnlocked when not passed (exactOptionalPropertyTypes)", () => {
    openUnlockModal("/vault/secret", "secret");
    const m = get(encryptionModal);
    expect(m?.kind).toBe("unlock");
    if (m?.kind === "unlock") {
      expect(m.onUnlocked).toBeUndefined();
    }
  });

  it("setEncryptionModalError attaches the error kind in place", () => {
    openUnlockModal("/vault/secret", "secret");
    setEncryptionModalError("wrong");
    const m = get(encryptionModal);
    expect(m?.error).toBe("wrong");
  });

  it("closeEncryptionModal clears state", () => {
    openEncryptModal("/x", "x");
    closeEncryptionModal();
    expect(get(encryptionModal)).toBeNull();
  });
});
