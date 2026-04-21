// Shared module-level cache for reading note content from disk, keyed by
// vault-relative path. Backs two consumers:
//   - `embedPlugin.ts` (note-embed rendering `![[Foo]]`)
//   - `vaultApiStoreBridge.ts` (template expressions like
//     `{{vault.notes.where(n => n.content.contains("X"))}}`)
//
// Before extraction each consumer ran its own cache; invalidation drift
// between the two was the bug #319 root-cause. One cache, one invalidation
// surface.
//
// Invariants
//   - `readCached(rel)` is synchronous; returns the current string or `null`.
//   - `requestLoad(rel)` enqueues an async `readFile` IPC if no entry exists
//     and no fetch is already queued or in flight for that key. On
//     completion the cache fills and subscribers are notified via the
//     `noteContentCacheVersion` store.
//   - `invalidate(rel)` + `clear()` drop the `inFlight` slot for the
//     affected key so a subsequent `requestLoad` can immediately re-enqueue.
//     The old in-flight fetch still resolves, but its `generation` token is
//     stale at that point so its result is discarded — no stale write, no
//     "silently wedged" key (PR #320 review B1/B2).
//
// Invalidation sources
//   1. `listenFileChange` — external edits the watcher sees
//   2. `tabStore` diff-on-snapshot — internal auto-saves (suppressed from
//      the watcher by `write_ignore`, so we diff lastSavedContent instead)
//   3. `vaultStore.currentPath` change → `clear()`
//
// Limits
//   - LRU: `LRU_MAX_ENTRIES` entries. Map-insertion-order drives eviction;
//     each hit re-inserts to approximate LRU without a second data structure.
//   - Per-file cap: files larger than `MAX_FILE_BYTES` are fetched but not
//     retained, so a single huge file cannot blow the budget.
//   - Concurrency: at most `MAX_CONCURRENT` reads in flight; overflow queues.
//
// Batching
//   - Version bumps coalesce through a microtask so N parallel completions
//     produce one re-render tick, not N.
//
// Known non-goals (deferred follow-ups)
//   - `.first()` / `.any()` during warm-up may be non-deterministic across
//     consecutive renders until every touched note has landed.
//   - No eager bulk pre-fetch on vault open.
//   - Unreadable files cache as `""` (cheap + keeps `.contains("X")` false).
//     Side effect: `.contains("")` returns `true` for those notes — users
//     who care can filter via `.where(n => n.content.length > 0)` first.

import { writable, type Readable, get } from "svelte/store";

import { vaultStore } from "../store/vaultStore";
import { tabStore } from "../store/tabStore";
import { readFile } from "../ipc/commands";
import { listenFileChange } from "../ipc/events";
import { toVaultRel, absFromRel } from "./vaultPath";

const LRU_MAX_ENTRIES = 1000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONCURRENT = 8;

const cache: Map<string, string> = new Map();
const inFlight: Set<string> = new Set();
// Map used as an ordered set — preserves FIFO order while giving O(1)
// membership checks (the old `queue.indexOf` was O(n) per requestLoad and
// mattered once a vault-wide `.where(n => n.content...)` enqueues thousands).
const queue: Map<string, true> = new Map();
let activeFetches = 0;

// Per-key generation token. `invalidate()` / `clear()` bump it; a resolved
// fetch whose generation no longer matches drops its result — defends against
// (a) delete-during-load ghost resurrection and (b) vault-switch-during-load
// races where content for vault A would otherwise land in the cache of
// vault B.
const generation: Map<string, number> = new Map();
function bumpGeneration(rel: string): number {
  const g = (generation.get(rel) ?? 0) + 1;
  generation.set(rel, g);
  return g;
}

const versionStore = writable(0);
export const noteContentCacheVersion: Readable<number> = versionStore;

let pendingBump = false;
function scheduleBump(): void {
  if (pendingBump) return;
  pendingBump = true;
  queueMicrotask(() => {
    pendingBump = false;
    versionStore.update((v) => v + 1);
  });
}

function currentVaultPath(): string | null {
  return get(vaultStore).currentPath ?? null;
}

// --- Public API ---------------------------------------------------------

export function readCached(rel: string): string | null {
  const value = cache.get(rel);
  if (value === undefined) return null;
  // LRU touch.
  cache.delete(rel);
  cache.set(rel, value);
  return value;
}

export function requestLoad(rel: string): void {
  if (cache.has(rel) || inFlight.has(rel) || queue.has(rel)) return;
  queue.set(rel, true);
  pump();
}

export function invalidate(rel: string): boolean {
  bumpGeneration(rel);
  const hadEntry = cache.delete(rel);
  // B2 fix: drop the in-flight slot so the next `requestLoad` can re-enqueue
  // immediately. The already-running fetch will still resolve but fail the
  // generation check and discard its result.
  inFlight.delete(rel);
  queue.delete(rel);
  if (hadEntry) scheduleBump();
  return hadEntry;
}

export function clear(): void {
  // Bump generation for every in-flight key so their resolutions drop when
  // they compare their captured token against the post-bump current value.
  // Keys only in the queue never started a fetch, so their generation is
  // meaningless; keys only in `cache` have nothing pending to drop.
  for (const rel of inFlight) bumpGeneration(rel);
  cache.clear();
  queue.clear();
  // B1 fix: releasing in-flight slots lets a fresh `requestLoad(rel)` after
  // the clear re-enqueue immediately instead of early-returning forever.
  inFlight.clear();
  // `generation` is intentionally not cleared — the bumped values are the
  // sentinels that make stale resolves drop. Map growth is bounded by the
  // count of unique keys that have ever been invalidated in this session;
  // for a 10k-note vault under normal usage that is well under 1 MB.
  scheduleBump();
}

// --- Internals ----------------------------------------------------------

function pump(): void {
  while (activeFetches < MAX_CONCURRENT && queue.size > 0) {
    // Pull FIFO: iterator returns insertion order.
    const rel = queue.keys().next().value as string;
    queue.delete(rel);
    if (cache.has(rel) || inFlight.has(rel)) continue;
    void doFetch(rel);
  }
}

async function doFetch(rel: string): Promise<void> {
  const vault = currentVaultPath();
  const abs = absFromRel(rel, vault);
  if (abs === null) return;
  const gen = generation.get(rel) ?? 0;
  inFlight.add(rel);
  activeFetches++;
  try {
    const content = await readFile(abs);
    if ((generation.get(rel) ?? 0) !== gen) return;
    if (content.length > MAX_FILE_BYTES) {
      if (import.meta.env?.DEV) {
        // Surface the skip in dev so a user with a giant note doesn't silently
        // wonder why `.contains(...)` never matches it.
        console.debug(
          `[noteContentCache] skipping cache for ${rel}: ${content.length} bytes exceeds cap ${MAX_FILE_BYTES}`,
        );
      }
      return;
    }
    setCache(rel, content);
  } catch {
    if ((generation.get(rel) ?? 0) === gen) {
      // Cache an empty string for unreadable files. Keeps `.contains("X")`
      // returning false and prevents an every-render retry storm for a
      // permanently broken path. Trade-off documented in the module header.
      setCache(rel, "");
    }
  } finally {
    // `invalidate` / `clear` may have already released the slot — `Set.delete`
    // on an absent key is a safe no-op, so the finally block is idempotent.
    inFlight.delete(rel);
    activeFetches--;
    scheduleBump();
    pump();
  }
}

function setCache(rel: string, content: string): void {
  if (cache.has(rel)) cache.delete(rel);
  cache.set(rel, content);
  if (cache.size > LRU_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// --- Wiring: invalidation sources ---------------------------------------
//
// State captured at module scope (not inside wireOnce) so the test-only
// reset hook can wipe the `lastSaved*` and `lastVaultPath` snapshots too —
// otherwise two tests that touch different vault paths would leak state
// across cases.

const lastSavedByTabId: Map<string, string> = new Map();
let lastVaultPath: string | null | undefined = undefined;
let wired = false;
// Capture unlisten handles so HMR (Vite) can tear them down and avoid
// stacking duplicate subscriptions across hot reloads.
const teardown: Array<() => void> = [];

function wireOnce(): void {
  if (wired) return;
  wired = true;

  try {
    void listenFileChange((payload) => {
      const vault = currentVaultPath();
      const rel = toVaultRel(payload.path, vault);
      if (rel !== null) invalidate(rel);
      if (payload.new_path) {
        const newRel = toVaultRel(payload.new_path, vault);
        if (newRel !== null) invalidate(newRel);
      }
    })
      .then((unlisten) => {
        teardown.push(unlisten);
      })
      .catch(() => {
        // Tauri backend missing — tests run without IPC.
      });
  } catch {
    // Same reason — keep module importable under vitest.
  }

  // Diff lastSavedContent per-tab to catch internal auto-saves that the
  // watcher suppresses via `write_ignore`. Mirror of the pattern in the
  // previous embedPlugin.ts implementation (issue #27).
  teardown.push(
    tabStore.subscribe((state) => {
      const vault = currentVaultPath();
      for (const tab of state.tabs) {
        const prev = lastSavedByTabId.get(tab.id);
        if (prev !== tab.lastSavedContent) {
          lastSavedByTabId.set(tab.id, tab.lastSavedContent);
          const rel = toVaultRel(tab.filePath, vault);
          if (rel !== null) invalidate(rel);
        }
      }
      const live = new Set(state.tabs.map((t) => t.id));
      for (const id of Array.from(lastSavedByTabId.keys())) {
        if (!live.has(id)) lastSavedByTabId.delete(id);
      }
    }),
  );

  // Vault switch → full clear. First observation only records the baseline.
  teardown.push(
    vaultStore.subscribe((state) => {
      if (lastVaultPath === undefined) {
        lastVaultPath = state.currentPath;
        return;
      }
      if (state.currentPath !== lastVaultPath) {
        lastVaultPath = state.currentPath;
        clear();
        // A fresh vault means new tabs too; reset the per-tab snapshot map
        // so the first auto-save on the new vault isn't suppressed by a
        // stale match from the old vault's tab ids.
        lastSavedByTabId.clear();
      }
    }),
  );
}

// HMR teardown so Vite hot-reload doesn't stack duplicate subscriptions.
// `import.meta.hot` is undefined in production bundles and in vitest, so the
// guard keeps both paths silent.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const fn of teardown.splice(0)) {
      try {
        fn();
      } catch {
        // A failed teardown must not prevent the next handler from running.
      }
    }
    wired = false;
  });
}

wireOnce();

// --- Test hooks ---------------------------------------------------------
//
// Gated behind a dev/test check so a stray production caller can't silently
// wipe the cache. The import itself still succeeds in production — only the
// methods themselves throw.

const IS_TEST_ENV =
  (typeof import.meta !== "undefined" && import.meta.env?.MODE === "test") ||
  (typeof process !== "undefined" && process.env?.NODE_ENV === "test") ||
  (typeof globalThis !== "undefined" &&
    (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== undefined);

function assertTestEnv(): void {
  if (!IS_TEST_ENV) {
    throw new Error("__cacheForTests is only callable from test environments");
  }
}

export const __cacheForTests = {
  get: (rel: string) => (assertTestEnv(), cache.get(rel)),
  set: (rel: string, content: string) => (assertTestEnv(), setCache(rel, content)),
  has: (rel: string) => (assertTestEnv(), cache.has(rel)),
  size: () => (assertTestEnv(), cache.size),
  inFlightSize: () => (assertTestEnv(), inFlight.size),
  queueLength: () => (assertTestEnv(), queue.size),
  activeFetches: () => (assertTestEnv(), activeFetches),
  limits: () => (assertTestEnv(), { LRU_MAX_ENTRIES, MAX_FILE_BYTES, MAX_CONCURRENT }),
  reset: () => {
    assertTestEnv();
    cache.clear();
    inFlight.clear();
    queue.clear();
    activeFetches = 0;
    generation.clear();
    pendingBump = false;
    versionStore.set(0);
    // Wiping the wiring-layer snapshots too — otherwise a test that flips
    // vault paths inherits closure state from the previous test.
    lastSavedByTabId.clear();
    lastVaultPath = undefined;
  },
};
