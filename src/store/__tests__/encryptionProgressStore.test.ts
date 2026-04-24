import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";

import { encryptionProgressStore } from "../encryptionProgressStore";

describe("encryptionProgressStore (#357)", () => {
  beforeEach(() => {
    encryptionProgressStore.reset();
  });

  it("starts idle", () => {
    const state = get(encryptionProgressStore);
    expect(state.visible).toBe(false);
    expect(state.total).toBe(0);
    expect(state.error).toBeNull();
    expect(state.queued).toBe(false);
  });

  it("accumulates sealed count across payloads", () => {
    encryptionProgressStore.apply({
      inFlight: 0,
      total: 2,
      lastCompleted: "/vault/secret/a.png",
      queued: false,
      error: null,
    });
    encryptionProgressStore.apply({
      inFlight: 0,
      total: 1,
      lastCompleted: "/vault/secret/b.png",
      queued: false,
      error: null,
    });
    const state = get(encryptionProgressStore);
    expect(state.total).toBe(3);
    expect(state.visible).toBe(true);
    expect(state.lastCompleted).toBe("/vault/secret/b.png");
    expect(state.error).toBeNull();
  });

  it("flags the queued state for locked-folder drops", () => {
    encryptionProgressStore.apply({
      inFlight: 0,
      total: 0,
      lastCompleted: "/vault/secret/photo.png",
      queued: true,
      error: null,
    });
    const state = get(encryptionProgressStore);
    expect(state.queued).toBe(true);
    expect(state.visible).toBe(true);
    expect(state.error).toBeNull();
  });

  it("persists error until explicit reset", () => {
    encryptionProgressStore.apply({
      inFlight: 0,
      total: 1,
      lastCompleted: "/vault/secret/one.png",
      queued: false,
      error: null,
    });
    encryptionProgressStore.apply({
      inFlight: 0,
      total: 0,
      lastCompleted: null,
      queued: false,
      error: { path: "/vault/secret/bad.bin", message: "permission denied" },
    });
    let state = get(encryptionProgressStore);
    expect(state.error?.path).toBe("/vault/secret/bad.bin");
    expect(state.visible).toBe(true);

    encryptionProgressStore.reset();
    state = get(encryptionProgressStore);
    expect(state.error).toBeNull();
    expect(state.visible).toBe(false);
  });
});
