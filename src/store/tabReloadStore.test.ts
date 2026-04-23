// tabReloadStore tests — covers only the one-shot reload signal.
// Per-tab save-snapshot setters (setLastSavedContent/setLastSavedHash)
// live on tabLifecycleStore; see tabLifecycleStore.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { tabReloadStore } from "./tabReloadStore";

beforeEach(() => {
  tabReloadStore._reset();
});

describe("tabReloadStore — reload signal", () => {
  it("request() emits a new token with the given paths", () => {
    let observed: { token: string; paths: string[] } | null = null;
    const unsub = tabReloadStore.subscribe((s) => {
      if (s.pending) observed = s.pending;
    });
    tabReloadStore.request(["notes/a.md", "notes/b.md"]);
    unsub();
    expect(observed).not.toBeNull();
    expect(observed!.paths).toEqual(["notes/a.md", "notes/b.md"]);
    expect(observed!.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("request() with an empty array is a no-op", () => {
    let emissions = 0;
    const unsub = tabReloadStore.subscribe(() => {
      emissions += 1;
    });
    const initial = emissions;
    tabReloadStore.request([]);
    unsub();
    expect(emissions).toBe(initial);
  });

  it("two consecutive request() calls produce different tokens", () => {
    const tokens: string[] = [];
    const unsub = tabReloadStore.subscribe((s) => {
      if (s.pending) tokens.push(s.pending.token);
    });
    tabReloadStore.request(["a.md"]);
    tabReloadStore.request(["a.md"]);
    unsub();
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});
