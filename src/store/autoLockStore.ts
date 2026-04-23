// #345 — auto-lock timer for encrypted folders.
//
// Policy:
// - Frontend-only timer. ZERO per-keystroke IPC. The lock action
//   hits the backend exactly once per expiry.
// - Activity: keydown / pointerdown on the configured target
//   (typically `document`). Debounced inside the store so a burst
//   of keystrokes counts as one reset.
// - Focus changes DO NOT reset the timer. Only real input.
// - visibilitychange hidden→visible: if `Date.now()` shows the user
//   has been away longer than the timeout, lock immediately. Defends
//   against OS timer throttling while backgrounded.
// - One timer per unlocked root. We read the currently-active tab
//   from `tabStore` on every activity pulse to decide which root
//   (if any) owns the activity — no brittle DOM attribute contract.

import { settingsStore } from "./settingsStore";
import { tabStore } from "./tabStore";
import { lockFolder } from "../ipc/commands";

type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerState {
  /** `performance.now()` snapshot at the last activity. */
  lastActivity: number;
  /** Outstanding setTimeout handle, if any. */
  handle: TimerHandle | null;
  /** Absolute path of the root — cached so lock IPC survives a
   *  mid-countdown vault switch of the reactive `vaultRoot`. */
  absPath: string;
}

const timers = new Map<string, TimerState>();
let timeoutMs = 0;
let attached = false;
let unsubscribeSettings: (() => void) | null = null;
let detachActivity: (() => void) | null = null;
let detachVisibility: (() => void) | null = null;
let activeVaultRoot: string | null = null;
const ACTIVITY_DEBOUNCE_MS = 1000;

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function clearTimer(root: string): void {
  const t = timers.get(root);
  if (t?.handle) clearTimeout(t.handle);
  timers.delete(root);
}

async function fireLock(abs: string): Promise<void> {
  try {
    await lockFolder(abs);
  } catch {
    // Swallow: the folder may have been locked elsewhere (user action,
    // vault switch). Next open resets state.
  }
}

function schedule(root: string, absPath: string): void {
  if (timeoutMs <= 0) return;
  const prev = timers.get(root);
  if (prev?.handle) clearTimeout(prev.handle);
  const handle = setTimeout(() => {
    const t = timers.get(root);
    timers.delete(root);
    void fireLock(t?.absPath ?? absPath);
  }, timeoutMs);
  timers.set(root, { lastActivity: nowMs(), handle, absPath });
}

function joinAbs(vaultRoot: string, relPath: string): string {
  // Vault root may or may not have a trailing separator. Normalize
  // so `openFileAsTab`'s sibling bug (doubled slash) doesn't repeat
  // here.
  const trimmed = vaultRoot.replace(/[\\/]+$/, "");
  return `${trimmed}/${relPath}`;
}

function recordActivityForAbsTabPath(tabAbsPath: string): void {
  if (timeoutMs <= 0) return;
  if (!activeVaultRoot) return;
  // Normalize separators for the prefix check.
  const normTabAbs = tabAbsPath.replace(/\\/g, "/");
  const normVault = activeVaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const [rootRel, state] of timers.entries()) {
    const normRoot = `${normVault}/${rootRel}`.replace(/\/+$/, "");
    if (normTabAbs === normRoot || normTabAbs.startsWith(normRoot + "/")) {
      schedule(rootRel, state.absPath);
      return;
    }
  }
}

/**
 * Start (or replace) the auto-lock timer for a root that was just
 * unlocked. `vaultRoot` may be passed null — we then cache whatever
 * the last vault root was; callers that want to swap vault MUST
 * first call `resetAutoLockStore()`.
 */
export function armAutoLock(rootRel: string, vaultRoot: string | null): void {
  if (vaultRoot) activeVaultRoot = vaultRoot;
  if (!activeVaultRoot) return;
  if (timeoutMs <= 0) return;
  const abs = joinAbs(activeVaultRoot, rootRel);
  schedule(rootRel, abs);
}

/**
 * Disarm a root that was manually locked. Safe to call on a root
 * that is not currently armed — no-ops in that case.
 */
export function disarmAutoLock(rootRel: string): void {
  clearTimer(rootRel);
}

/**
 * Wire the activity listeners + settings subscription. Exactly once
 * per app mount. Subsequent calls after a `resetAutoLockStore()`
 * re-attach; calls without a reset are idempotent.
 */
export function attachAutoLockListeners(args: {
  vaultPath: string | null;
  /** Element whose keydown / pointerdown resets the timer. */
  target: Document | HTMLElement;
}): void {
  if (attached) {
    // Allow vault-root updates even on an already-attached store, so
    // the parent component can keep a single attach call and pass
    // `$vaultStore.currentPath` reactively.
    activeVaultRoot = args.vaultPath;
    return;
  }
  attached = true;
  activeVaultRoot = args.vaultPath;

  unsubscribeSettings = settingsStore.subscribe((s) => {
    const nextTimeout = Math.max(0, s.autoLockMinutes) * 60 * 1000;
    const changed = nextTimeout !== timeoutMs;
    timeoutMs = nextTimeout;
    if (!changed) return;
    if (timeoutMs === 0) {
      for (const root of [...timers.keys()]) clearTimer(root);
    } else {
      // Restart running timers so the new duration takes effect
      // without requiring fresh activity.
      for (const [root, state] of timers.entries()) {
        schedule(root, state.absPath);
      }
    }
  });

  let lastTick = 0;
  const onActivity = () => {
    const t = nowMs();
    if (t - lastTick < ACTIVITY_DEBOUNCE_MS) return;
    lastTick = t;
    const active = tabStore.getActiveTab?.();
    if (active?.filePath) {
      recordActivityForAbsTabPath(active.filePath);
    }
  };
  args.target.addEventListener("keydown", onActivity, { passive: true });
  args.target.addEventListener("pointerdown", onActivity, { passive: true });
  detachActivity = () => {
    args.target.removeEventListener("keydown", onActivity);
    args.target.removeEventListener("pointerdown", onActivity);
  };

  const onVisibility = () => {
    if (document.hidden) return;
    if (timeoutMs <= 0) return;
    const cutoff = nowMs() - timeoutMs;
    for (const [root, state] of [...timers.entries()]) {
      if (state.lastActivity < cutoff) {
        clearTimer(root);
        void fireLock(state.absPath);
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  detachVisibility = () => {
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Tear down every timer, subscription, and DOM listener. Called on
 * vault close, vault switch, and app teardown so a subsequent
 * `attachAutoLockListeners` starts from a clean slate without stale
 * rel-path timers that could resolve against a new vault root.
 */
export function resetAutoLockStore(): void {
  for (const root of [...timers.keys()]) clearTimer(root);
  unsubscribeSettings?.();
  detachActivity?.();
  detachVisibility?.();
  unsubscribeSettings = null;
  detachActivity = null;
  detachVisibility = null;
  attached = false;
  activeVaultRoot = null;
}

/** Test hook — do not use in production code. */
export function _getActiveTimers(): string[] {
  return [...timers.keys()];
}

/** Test hook — do not use in production code. */
export function _resetForTest(): void {
  resetAutoLockStore();
  timeoutMs = 0;
}
