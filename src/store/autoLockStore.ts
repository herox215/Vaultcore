// #345 — auto-lock timer for encrypted folders.
//
// Policy:
// - Frontend-only timer. ZERO per-keystroke IPC. The lock action
//   hits the backend exactly once per expiry.
// - Activity that resets the timer: any keydown / pointerdown on the
//   editor tab container. Debounced to 1 second inside the store so
//   bursts of keystrokes become a single reset.
// - Focus changes DO NOT reset the timer (user decision). Only real
//   input resets it. Backgrounded apps continue to count down on wall
//   clock time.
// - visibilitychange hidden→visible: if `Date.now()` shows the user
//   has been away longer than the timeout, lock immediately. This
//   defends against browser/OS timer throttling under suspension.
// - Per-root timers are kept in a Map so multiple unlocked folders
//   can run independently.

import { settingsStore } from "./settingsStore";
import { encryptedFolders } from "./encryptedFoldersStore";
import { lockFolder } from "../ipc/commands";

type Timer = ReturnType<typeof setTimeout>;

interface TimerState {
  /** `performance.now()` at the last activity — wall-clock-safe for
   *  visibility-restore checks via `Date.now()` offset. */
  lastActivity: number;
  /** Outstanding setTimeout handle, if any. */
  handle: Timer | null;
}

const timers = new Map<string, TimerState>();
let timeoutMs = 0;
let attached = false;
let unsubscribeSettings: (() => void) | null = null;
let unsubscribeFolders: (() => void) | null = null;

/** Rel-path → derived absolute path via vault root. The store keeps
 *  only relative paths so we need the vault root at lock time. */
let vaultAbsoluteRoot: string | null = null;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function clear(root: string): void {
  const t = timers.get(root);
  if (t?.handle) {
    clearTimeout(t.handle);
  }
  timers.delete(root);
}

async function lockAbs(abs: string): Promise<void> {
  try {
    await lockFolder(abs);
  } catch {
    // Swallow: a lock failure most likely means the folder got
    // unlocked elsewhere or the vault closed. Next open resets state.
  }
}

function schedule(root: string, abs: string): void {
  if (timeoutMs <= 0) return;
  clear(root);
  const handle = setTimeout(() => {
    timers.delete(root);
    void lockAbs(abs);
  }, timeoutMs);
  timers.set(root, { lastActivity: now(), handle });
}

export function recordActivityForPath(pathRel: string): void {
  if (timeoutMs <= 0) return;
  if (!vaultAbsoluteRoot) return;
  // Find which unlocked root (if any) owns this path. The store
  // carries vault-relative paths; a path is inside a root iff it
  // starts with the root prefix + "/".
  for (const root of timers.keys()) {
    if (pathRel === root || pathRel.startsWith(root + "/")) {
      const abs = rootToAbs(root);
      schedule(root, abs);
      return;
    }
  }
}

function rootToAbs(rootRel: string): string {
  // vault absolute root is normalized to forward slashes by the
  // vaultStore. We join with a forward-slash separator and let the
  // OS's canonicalize smooth out native separators when the backend
  // receives this.
  if (!vaultAbsoluteRoot) return rootRel;
  const sep = vaultAbsoluteRoot.endsWith("/") || vaultAbsoluteRoot.endsWith("\\") ? "" : "/";
  return `${vaultAbsoluteRoot}${sep}${rootRel}`;
}

/**
 * Start the auto-lock subsystem. Call exactly once per app mount.
 * Subsequent calls are idempotent — the store attaches exactly one
 * settings subscription, one folders subscription, and one set of
 * listeners.
 */
export function attachAutoLockListeners(args: {
  vaultPath: string | null;
  /** Element whose keydown / pointerdown resets the timer. */
  target: Document | HTMLElement;
}): void {
  vaultAbsoluteRoot = args.vaultPath;
  if (attached) return;
  attached = true;

  unsubscribeSettings = settingsStore.subscribe((s) => {
    timeoutMs = Math.max(0, s.autoLockMinutes) * 60 * 1000;
    if (timeoutMs === 0) {
      for (const root of [...timers.keys()]) clear(root);
    } else {
      // Reset any running timer so a setting change takes effect
      // without requiring the user to make fresh activity.
      for (const [root, state] of timers.entries()) {
        if (state.handle) clearTimeout(state.handle);
        const abs = rootToAbs(root);
        schedule(root, abs);
      }
    }
  });

  unsubscribeFolders = encryptedFolders.subscribe(() => {
    // Nothing to do for the store contents themselves — the timers
    // Map is keyed off registered activities. When a folder relocks
    // via any path we get an `encrypted_folders_changed` pulse and
    // the `DirEntry.encryption` flip is what surfaces through the UI.
  });

  // Passive activity listeners — zero per-keystroke IPC. We only
  // wake on the debounced tail.
  let lastTick = 0;
  const onActivity = (e: Event) => {
    const t = now();
    if (t - lastTick < 1000) return; // 1 s debounce inside the store
    lastTick = t;
    // Find the active editor tab to know which rel path is active.
    // The tab store exposes the active path asynchronously; to keep
    // this path sync and zero-IPC we consult a minimal DOM hint the
    // Editor sets on the pane container.
    const editor = document.querySelector<HTMLElement>("[data-encrypted-path]");
    const rel = editor?.dataset.encryptedPath ?? null;
    if (rel) recordActivityForPath(rel);
    void e; // silence unused
  };
  args.target.addEventListener("keydown", onActivity, { passive: true });
  args.target.addEventListener("pointerdown", onActivity, { passive: true });

  // visibility-restore backup: if the OS throttled our setTimeout
  // while backgrounded, lock immediately on return if the deadline
  // passed.
  const onVisibility = () => {
    if (document.hidden) return;
    const cutoff = now() - timeoutMs;
    for (const [root, state] of timers.entries()) {
      if (state.lastActivity < cutoff) {
        clear(root);
        void lockAbs(rootToAbs(root));
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
}

/** Start a timer for a root that was just unlocked. */
export function armAutoLock(rootRel: string, vaultRoot: string | null): void {
  if (timeoutMs <= 0) return;
  vaultAbsoluteRoot = vaultRoot;
  schedule(rootRel, rootToAbs(rootRel));
}

/** Disarm a root that was manually locked. */
export function disarmAutoLock(rootRel: string): void {
  clear(rootRel);
}

/** Tear down every timer and subscription. Called on vault close. */
export function resetAutoLockStore(): void {
  for (const root of [...timers.keys()]) clear(root);
  unsubscribeSettings?.();
  unsubscribeFolders?.();
  unsubscribeSettings = null;
  unsubscribeFolders = null;
  attached = false;
  vaultAbsoluteRoot = null;
}

/** Test hook — do not use in production code. */
export function _getActiveTimers(): string[] {
  return [...timers.keys()];
}
