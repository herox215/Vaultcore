// #321 — Reading Mode must re-render when one of the vault-describing stores
// ticks, not just when the tab id changes. Without this subscription chain,
// a template like `{{vault.notes.where(n => n.content.contains("X"))}}`
// would stay frozen with the vault snapshot from tab-open time.
//
// Strategy: mount ReadingView against a stubbed `readFile`, let the initial
// load settle, then bump `vaultStore` and assert `readFile` is called again.
// A second sub-test uses `noteContentCacheVersion` to cover the #319
// invalidation path specifically — a store that only exists for this trigger
// chain, so a regression that severs it shows up here immediately.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${encodeURIComponent(p)}`,
}));

const readFileMock = vi.fn<(path: string) => Promise<string>>();

vi.mock("../../../ipc/commands", () => ({
  readFile: (path: string) => readFileMock(path),
}));

import ReadingView from "../ReadingView.svelte";
import { vaultStore } from "../../../store/vaultStore";
import { resolvedLinksStore } from "../../../store/resolvedLinksStore";
import { __cacheForTests, invalidate as invalidateCache } from "../../../lib/noteContentCache";
import type { Tab } from "../../../store/tabStore";

/**
 * Trigger a `noteContentCacheVersion` bump from test code: seed a cache
 * entry, then invalidate it. Goes through the real public API so a future
 * refactor of the bump scheduling is exercised too.
 */
function bumpNoteContentCacheVersion(): void {
  const key = `_vctest_bump_${Math.random().toString(36).slice(2)}`;
  __cacheForTests.set(key, "x");
  invalidateCache(key);
}

const VAULT = "/tmp/reading-reload-vault";
const FILE_PATH = "notes/sample.md";

function makeTab(): Tab {
  return {
    id: "tab-1",
    filePath: FILE_PATH,
    isDirty: false,
    scrollPos: 0,
    cursorPos: 0,
    lastSaved: 0,
    lastSavedContent: "",
  };
}

async function waitForReadCount(n: number, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readFileMock.mock.calls.length >= n) return;
    await tick();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `expected ${n} reads, got ${readFileMock.mock.calls.length}`,
  );
}

describe("ReadingView live-reload on vault-store ticks (#321)", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    readFileMock.mockResolvedValue("# Hello");
    vaultStore.setReady({ currentPath: VAULT, fileList: [FILE_PATH], fileCount: 1 });
  });

  it("re-reads the file when vaultStore ticks", async () => {
    render(ReadingView, {
      props: { tab: makeTab(), isActive: true },
    });

    await waitForReadCount(1);
    expect(readFileMock.mock.calls).toHaveLength(1);

    // Simulate a rename / new file landing in the vault. The store update
    // bumps both subscribers; the microtask in ReadingView coalesces the
    // burst into a single reload.
    vaultStore.setReady({
      currentPath: VAULT,
      fileList: [FILE_PATH, "notes/new.md"],
      fileCount: 2,
    });

    await waitForReadCount(2);
    expect(readFileMock.mock.calls).toHaveLength(2);
  });

  it("re-reads the file when noteContentCacheVersion bumps (#319 integration)", async () => {
    render(ReadingView, {
      props: { tab: makeTab(), isActive: true },
    });

    await waitForReadCount(1);

    bumpNoteContentCacheVersion();

    await waitForReadCount(2);
    expect(readFileMock.mock.calls).toHaveLength(2);
  });

  // #309 — Reading Mode renders wiki-links from template output with a
  // snapshot of the resolved-links map at render time. After a new file
  // lands, `resolvedLinksStore.markReady()` fires to signal the map is fresh
  // and Reading Mode must re-read + re-render so `[[New Note]]` flips from
  // unresolved to resolved without a manual tab reload.
  it("re-reads the file when resolvedLinksStore.markReady() fires (#309)", async () => {
    render(ReadingView, {
      props: { tab: makeTab(), isActive: true },
    });

    await waitForReadCount(1);

    resolvedLinksStore.markReady();

    await waitForReadCount(2);
    expect(readFileMock.mock.calls).toHaveLength(2);
  });

  it("coalesces synchronous same-tick vaultStore ticks into a single reload", async () => {
    render(ReadingView, {
      props: { tab: makeTab(), isActive: true },
    });

    await waitForReadCount(1);

    // Fire three vaultStore updates synchronously in the same tick. All
    // three trigger callbacks run before the coalescing microtask fires,
    // so they must collapse to exactly one reload — not three.
    vaultStore.setReady({ currentPath: VAULT, fileList: [FILE_PATH], fileCount: 1 });
    vaultStore.setReady({ currentPath: VAULT, fileList: [FILE_PATH, "a.md"], fileCount: 2 });
    vaultStore.setReady({ currentPath: VAULT, fileList: [FILE_PATH, "a.md", "b.md"], fileCount: 3 });

    await waitForReadCount(2);
    // The three bursts coalesce into exactly one additional read. A
    // regression that drops the coalescing microtask would raise this to
    // 3 — asserting `=== 2` locks that property in place.
    expect(readFileMock.mock.calls).toHaveLength(2);
  });
});
