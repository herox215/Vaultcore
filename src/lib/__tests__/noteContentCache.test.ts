// Unit tests for the shared note-content cache (#319). Exercise the LRU,
// invalidation, generation-token, concurrency, and version-bump-batching
// surfaces — the pieces that went missing when the cache lived inline in
// `embedPlugin.ts`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

const handlerSlot = vi.hoisted(() => {
  const slot: { cb: ((p: { path: string; new_path?: string | null }) => void) | null } = {
    cb: null,
  };
  return slot;
});

const readerSlot = vi.hoisted(() => ({
  impl: (_path: string) => Promise.resolve(""),
}));

vi.mock("../../ipc/events", () => ({
  listenFileChange: vi.fn(async (cb: (p: { path: string; new_path?: string | null }) => void) => {
    handlerSlot.cb = cb;
    return () => {
      handlerSlot.cb = null;
    };
  }),
}));
vi.mock("../../ipc/commands", () => ({
  readFile: vi.fn((path: string) => readerSlot.impl(path)),
}));

import {
  readCached,
  requestLoad,
  invalidate,
  clear,
  onCacheChanged,
  noteContentCacheVersion,
  __cacheForTests,
} from "../noteContentCache";
import { vaultStore } from "../../store/vaultStore";

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("noteContentCache — basic read/write", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
    readerSlot.impl = () => Promise.resolve("");
  });

  it("readCached returns null for an unknown key", () => {
    expect(readCached("a.md")).toBeNull();
  });

  it("requestLoad populates the cache via the injected reader", async () => {
    readerSlot.impl = (p) => Promise.resolve(`hello-${p}`);
    requestLoad("a.md");
    await flushMicrotasks();
    expect(readCached("a.md")).toBe("hello-/vault/a.md");
  });

  it("requestLoad dedupes concurrent loads for the same path", async () => {
    let calls = 0;
    readerSlot.impl = (_p) => {
      calls++;
      return Promise.resolve("x");
    };
    requestLoad("a.md");
    requestLoad("a.md");
    requestLoad("a.md");
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  it("invalidate drops an existing entry and returns true", () => {
    __cacheForTests.set("a.md", "old");
    expect(invalidate("a.md")).toBe(true);
    expect(readCached("a.md")).toBeNull();
  });

  it("invalidate on an absent key returns false without side effects", () => {
    expect(invalidate("never.md")).toBe(false);
  });
});

describe("noteContentCache — LRU eviction", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("evicts the oldest entry when the cap is exceeded", () => {
    const { LRU_MAX_ENTRIES } = __cacheForTests.limits();
    for (let i = 0; i < LRU_MAX_ENTRIES; i++) {
      __cacheForTests.set(`n${i}.md`, String(i));
    }
    expect(__cacheForTests.size()).toBe(LRU_MAX_ENTRIES);
    __cacheForTests.set("overflow.md", "x");
    expect(__cacheForTests.size()).toBe(LRU_MAX_ENTRIES);
    // Oldest (`n0.md`) should be gone; newest is retained.
    expect(readCached("n0.md")).toBeNull();
    expect(readCached("overflow.md")).toBe("x");
  });

  it("touching an entry via readCached moves it to the newest slot", () => {
    const { LRU_MAX_ENTRIES } = __cacheForTests.limits();
    for (let i = 0; i < LRU_MAX_ENTRIES; i++) {
      __cacheForTests.set(`n${i}.md`, String(i));
    }
    // Read the oldest — should promote it.
    expect(readCached("n0.md")).toBe("0");
    __cacheForTests.set("overflow.md", "x");
    // n0 promoted, so n1 is the oldest and gets evicted instead.
    expect(readCached("n0.md")).toBe("0");
    expect(readCached("n1.md")).toBeNull();
  });
});

describe("noteContentCache — per-file size cap", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("does not retain files larger than the per-file cap", async () => {
    const { MAX_FILE_BYTES } = __cacheForTests.limits();
    const big = "x".repeat(MAX_FILE_BYTES + 1);
    readerSlot.impl = () => Promise.resolve(big);
    requestLoad("huge.md");
    await flushMicrotasks();
    expect(__cacheForTests.has("huge.md")).toBe(false);
  });

  it("retains files at or below the per-file cap", async () => {
    const { MAX_FILE_BYTES } = __cacheForTests.limits();
    const ok = "x".repeat(MAX_FILE_BYTES);
    readerSlot.impl = () => Promise.resolve(ok);
    requestLoad("fits.md");
    await flushMicrotasks();
    expect(__cacheForTests.has("fits.md")).toBe(true);
  });
});

describe("noteContentCache — generation tokens (race safety)", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("invalidate-during-load discards the stale resolve", async () => {
    let resolve: (v: string) => void = () => {};
    readerSlot.impl = () => new Promise<string>((r) => { resolve = r; });
    requestLoad("a.md");
    // Load is in flight. Invalidate bumps the generation.
    invalidate("a.md");
    resolve("stale-content");
    await flushMicrotasks();
    expect(readCached("a.md")).toBeNull();
  });

  it("clear-during-load discards the stale resolve", async () => {
    let resolve: (v: string) => void = () => {};
    readerSlot.impl = () => new Promise<string>((r) => { resolve = r; });
    requestLoad("a.md");
    clear();
    resolve("stale-vault-a-content");
    await flushMicrotasks();
    expect(readCached("a.md")).toBeNull();
  });

  it("a successful resolve after a fresh requestLoad does populate", async () => {
    let resolve: (v: string) => void = () => {};
    readerSlot.impl = () => new Promise<string>((r) => { resolve = r; });
    requestLoad("a.md");
    resolve("fresh");
    await flushMicrotasks();
    expect(readCached("a.md")).toBe("fresh");
  });
});

describe("noteContentCache — failure handling", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("caches an empty string on read failure (no retry storm)", async () => {
    let calls = 0;
    readerSlot.impl = () => {
      calls++;
      return Promise.reject(new Error("permission-denied"));
    };
    requestLoad("bad.md");
    await flushMicrotasks();
    expect(readCached("bad.md")).toBe("");
    // Second requestLoad must not re-fetch.
    requestLoad("bad.md");
    await flushMicrotasks();
    expect(calls).toBe(1);
  });
});

describe("noteContentCache — version-bump batching", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("coalesces concurrent completions inside one microtask into one bump", async () => {
    readerSlot.impl = (p) => Promise.resolve(p);
    const baseline = get(noteContentCacheVersion);
    const { MAX_CONCURRENT } = __cacheForTests.limits();
    // Load exactly one concurrency-batch worth so all completions land in
    // the same microtask — across batches we'd legitimately get one bump
    // per wave, which is still better than 1-per-resolve but not what this
    // test asserts.
    for (let i = 0; i < MAX_CONCURRENT; i++) requestLoad(`n${i}.md`);
    await flushMicrotasks();
    const bumped = get(noteContentCacheVersion);
    expect(bumped - baseline).toBe(1);
  });

  it("keeps the bump count proportional to batches, not to completions", async () => {
    readerSlot.impl = (p) => Promise.resolve(p);
    const baseline = get(noteContentCacheVersion);
    for (let i = 0; i < 50; i++) requestLoad(`n${i}.md`);
    await flushMicrotasks();
    const bumped = get(noteContentCacheVersion);
    // 50 completions must NOT produce 50 bumps. Upper bound: one bump per
    // concurrency wave (~50/8 = 7 waves) plus some slack for microtask
    // timing. 50 would mean the batching is dead.
    expect(bumped - baseline).toBeLessThan(15);
    expect(bumped - baseline).toBeGreaterThan(0);
  });
});

describe("noteContentCache — concurrency cap", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("never runs more than MAX_CONCURRENT fetches at once", async () => {
    const { MAX_CONCURRENT } = __cacheForTests.limits();
    let peak = 0;
    let active = 0;
    const resolvers: Array<() => void> = [];
    readerSlot.impl = () =>
      new Promise<string>((r) => {
        active++;
        if (active > peak) peak = active;
        resolvers.push(() => {
          active--;
          r("x");
        });
      });
    for (let i = 0; i < MAX_CONCURRENT * 3; i++) requestLoad(`n${i}.md`);
    // Let the first batch fire but not yet resolve.
    await flushMicrotasks();
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT);
    // Drain.
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await flushMicrotasks();
    }
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT);
  });
});

describe("noteContentCache — subscriber notifications", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("onCacheChanged fires after a successful load", async () => {
    let fired = 0;
    const unsub = onCacheChanged(() => { fired++; });
    readerSlot.impl = () => Promise.resolve("x");
    requestLoad("a.md");
    await flushMicrotasks();
    expect(fired).toBeGreaterThan(0);
    unsub();
  });

  it("onCacheChanged unsubscribe stops firing", async () => {
    let fired = 0;
    const unsub = onCacheChanged(() => { fired++; });
    unsub();
    readerSlot.impl = () => Promise.resolve("x");
    requestLoad("a.md");
    await flushMicrotasks();
    expect(fired).toBe(0);
  });

  it("isolates errors thrown by one subscriber from the others", async () => {
    let second = 0;
    onCacheChanged(() => { throw new Error("boom"); });
    onCacheChanged(() => { second++; });
    readerSlot.impl = () => Promise.resolve("x");
    requestLoad("a.md");
    await flushMicrotasks();
    expect(second).toBeGreaterThan(0);
  });
});

describe("noteContentCache — external file-change invalidation", () => {
  beforeEach(() => {
    __cacheForTests.reset();
    vaultStore.setReady({ currentPath: "/vault", fileList: [], fileCount: 0 });
  });

  it("drops the cache entry when the watcher reports a modify", () => {
    __cacheForTests.set("a.md", "old");
    // Watcher payload carries absolute paths; the module's own toVaultRel
    // handles the mapping. If the subscription never wired (no Tauri in the
    // test env — our vi.mock returns a resolved promise that stashes the
    // handler), `handlerSlot.cb` is set.
    expect(handlerSlot.cb).not.toBeNull();
    handlerSlot.cb!({ path: "/vault/a.md" });
    expect(readCached("a.md")).toBeNull();
  });

  it("handles rename via new_path", () => {
    __cacheForTests.set("old.md", "content");
    __cacheForTests.set("new.md", "target");
    handlerSlot.cb!({ path: "/vault/old.md", new_path: "/vault/new.md" });
    expect(readCached("old.md")).toBeNull();
    expect(readCached("new.md")).toBeNull();
  });

  it("ignores events for paths outside the vault", () => {
    __cacheForTests.set("a.md", "content");
    handlerSlot.cb!({ path: "/somewhere/else/a.md" });
    expect(readCached("a.md")).toBe("content");
  });
});
