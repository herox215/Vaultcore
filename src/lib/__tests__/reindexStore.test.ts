/**
 * reindexStore tests — payload application, idle reset, isActive helper.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { reindexStore, isActive } from "../../store/reindexStore";
import type { ReindexProgressPayload } from "../../ipc/events";

const base: ReindexProgressPayload = {
  done: 0,
  total: 0,
  skipped: 0,
  embedded: 0,
  phase: "scan",
  eta_seconds: null,
};

describe("reindexStore", () => {
  beforeEach(() => {
    reindexStore.reset();
  });

  it("starts idle", () => {
    const state = get(reindexStore);
    expect(state.phase).toBe("idle");
    expect(state.done).toBe(0);
    expect(state.total).toBe(0);
    expect(state.etaSeconds).toBeNull();
    expect(isActive(state)).toBe(false);
  });

  it("apply() maps snake_case eta_seconds to etaSeconds and mirrors phase", () => {
    reindexStore.apply({ ...base, phase: "index", total: 100, done: 42, eta_seconds: 17 });
    const state = get(reindexStore);
    expect(state.phase).toBe("index");
    expect(state.done).toBe(42);
    expect(state.total).toBe(100);
    expect(state.etaSeconds).toBe(17);
    expect(isActive(state)).toBe(true);
  });

  it("isActive() is true only during scan/index", () => {
    reindexStore.apply({ ...base, phase: "scan" });
    expect(isActive(get(reindexStore))).toBe(true);

    reindexStore.apply({ ...base, phase: "index" });
    expect(isActive(get(reindexStore))).toBe(true);

    reindexStore.apply({ ...base, phase: "done", done: 10, total: 10 });
    expect(isActive(get(reindexStore))).toBe(false);

    reindexStore.apply({ ...base, phase: "cancelled" });
    expect(isActive(get(reindexStore))).toBe(false);
  });

  it("reset() returns the store to its initial idle state", () => {
    reindexStore.apply({ ...base, phase: "index", done: 500, total: 1000 });
    reindexStore.reset();
    const state = get(reindexStore);
    expect(state.phase).toBe("idle");
    expect(state.done).toBe(0);
    expect(state.total).toBe(0);
  });

  it("successive applies overwrite — the store carries only the latest payload", () => {
    reindexStore.apply({ ...base, phase: "index", done: 10, total: 100, skipped: 2, embedded: 8 });
    reindexStore.apply({ ...base, phase: "index", done: 20, total: 100, skipped: 2, embedded: 18 });
    const state = get(reindexStore);
    expect(state.done).toBe(20);
    expect(state.embedded).toBe(18);
  });
});
