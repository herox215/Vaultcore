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
//     completion the cache fills and subscribers are notified.
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
//   - Unreadable files cache as `""` (mirrors the pre-existing embed
//     behaviour). `.contains("X")` stays `false`; `.contains("")` stays
//     `true`, identical to the old code path.

import { writable, type Readable, get } from "svelte/store";

import { vaultStore } from "../store/vaultStore";
import { tabStore } from "../store/tabStore";
import { readFile } from "../ipc/commands";
import { listenFileChange } from "../ipc/events";

const LRU_MAX_ENTRIES = 1000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONCURRENT = 8;

const cache: Map<string, string> = new Map();
const inFlight: Set<string> = new Set();
const queue: string[] = [];
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

function toVaultRel(absPath: string): string | null {
  const vault = get(vaultStore).currentPath;
  if (!vault) return null;
  const absFwd = absPath.replace(/\\/g, "/");
  const vaultFwd = vault.replace(/\\/g, "/").replace(/\/$/, "");
  if (absFwd === vaultFwd) return "";
  if (!absFwd.startsWith(vaultFwd + "/")) return null;
  return absFwd.slice(vaultFwd.length + 1);
}

function absFromRel(rel: string): string | null {
  const vault = get(vaultStore).currentPath;
  if (!vault) return null;
  const v = vault.replace(/\\/g, "/").replace(/\/$/, "");
  return `${v}/${rel}`;
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
  if (cache.has(rel) || inFlight.has(rel)) return;
  if (queue.indexOf(rel) !== -1) return;
  queue.push(rel);
  pump();
}

export function invalidate(rel: string): boolean {
  bumpGeneration(rel);
  const hadEntry = cache.delete(rel);
  if (hadEntry) scheduleBump();
  return hadEntry;
}

export function clear(): void {
  // Bump generation for every key the module knows about so any resolving
  // in-flight fetches discard themselves instead of re-populating the fresh
  // post-clear cache with stale content.
  const seen = new Set<string>();
  for (const k of cache.keys()) seen.add(k);
  for (const k of inFlight) seen.add(k);
  for (const k of queue) seen.add(k);
  for (const k of seen) bumpGeneration(k);
  cache.clear();
  queue.length = 0;
  // `inFlight` is intentionally not touched — the fetches themselves keep
  // running, but their completion handlers check generation and no-op.
  scheduleBump();
  notifyImperative();
}

// Imperative subscriber list for consumers that can't use Svelte stores
// (CM6 ViewPlugin instances that must dispatch a StateEffect per view).
const subscribers: Set<() => void> = new Set();

export function onCacheChanged(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function notifyImperative(): void {
  for (const fn of Array.from(subscribers)) {
    try {
      fn();
    } catch {
      // Isolate subscriber errors — one bad handler must not break others.
    }
  }
}

// --- Internals ----------------------------------------------------------

function pump(): void {
  while (activeFetches < MAX_CONCURRENT && queue.length > 0) {
    const rel = queue.shift()!;
    if (cache.has(rel) || inFlight.has(rel)) continue;
    void doFetch(rel);
  }
}

async function doFetch(rel: string): Promise<void> {
  const abs = absFromRel(rel);
  if (abs === null) return;
  const gen = generation.get(rel) ?? 0;
  inFlight.add(rel);
  activeFetches++;
  try {
    const content = await readFile(abs);
    if ((generation.get(rel) ?? 0) !== gen) return;
    if (content.length > MAX_FILE_BYTES) return;
    setCache(rel, content);
  } catch {
    if ((generation.get(rel) ?? 0) === gen) {
      // Mirror the pre-existing embed-plugin behaviour: failures cache as
      // empty string so the UI doesn't retry on every render.
      setCache(rel, "");
    }
  } finally {
    inFlight.delete(rel);
    activeFetches--;
    scheduleBump();
    notifyImperative();
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

let wired = false;
function wireOnce(): void {
  if (wired) return;
  wired = true;

  try {
    void listenFileChange((payload) => {
      const rel = toVaultRel(payload.path);
      if (rel !== null) invalidate(rel);
      if (payload.new_path) {
        const newRel = toVaultRel(payload.new_path);
        if (newRel !== null) invalidate(newRel);
      }
    }).catch(() => {
      // Tauri backend missing — tests run without IPC.
    });
  } catch {
    // Same reason — keep module importable under vitest.
  }

  // Diff lastSavedContent per-tab to catch internal auto-saves that the
  // watcher suppresses via `write_ignore`. Mirror of the pattern in the
  // previous embedPlugin.ts implementation (issue #27).
  const lastSavedByTabId: Map<string, string> = new Map();
  tabStore.subscribe((state) => {
    for (const tab of state.tabs) {
      const prev = lastSavedByTabId.get(tab.id);
      if (prev !== tab.lastSavedContent) {
        lastSavedByTabId.set(tab.id, tab.lastSavedContent);
        const rel = toVaultRel(tab.filePath);
        if (rel !== null) invalidate(rel);
      }
    }
    const live = new Set(state.tabs.map((t) => t.id));
    for (const id of Array.from(lastSavedByTabId.keys())) {
      if (!live.has(id)) lastSavedByTabId.delete(id);
    }
  });

  // Vault switch → full clear. Initial subscription call doesn't clear
  // because `lastVaultPath` starts at the initial value.
  let lastVaultPath: string | null | undefined = undefined;
  vaultStore.subscribe((state) => {
    if (lastVaultPath === undefined) {
      lastVaultPath = state.currentPath;
      return;
    }
    if (state.currentPath !== lastVaultPath) {
      lastVaultPath = state.currentPath;
      clear();
    }
  });
}

wireOnce();

// --- Test hooks ---------------------------------------------------------

export const __cacheForTests = {
  get: (rel: string) => cache.get(rel),
  set: (rel: string, content: string) => setCache(rel, content),
  has: (rel: string) => cache.has(rel),
  size: () => cache.size,
  inFlightSize: () => inFlight.size,
  queueLength: () => queue.length,
  activeFetches: () => activeFetches,
  limits: () => ({ LRU_MAX_ENTRIES, MAX_FILE_BYTES, MAX_CONCURRENT }),
  reset: () => {
    cache.clear();
    inFlight.clear();
    queue.length = 0;
    activeFetches = 0;
    generation.clear();
    pendingBump = false;
    versionStore.set(0);
  },
};
