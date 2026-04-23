// #345 — auto-lock store. Tests the lifecycle guarantees and the
// stale-vault-root regression Aristotle flagged in PR #350 review.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../ipc/commands", () => ({
  lockFolder: vi.fn(async () => {}),
}));

vi.mock("../tabStore", () => ({
  tabStore: {
    getActiveTab: vi.fn(),
  },
}));

import { lockFolder } from "../../ipc/commands";
import { tabStore } from "../tabStore";
import {
  _getActiveTimers,
  _resetForTest,
  armAutoLock,
  attachAutoLockListeners,
  disarmAutoLock,
  resetAutoLockStore,
} from "../autoLockStore";
import { settingsStore } from "../settingsStore";

const lockFolderMock = lockFolder as unknown as ReturnType<typeof vi.fn>;
const getActiveTabMock = tabStore.getActiveTab as unknown as ReturnType<typeof vi.fn>;

describe("autoLockStore", () => {
  beforeEach(() => {
    _resetForTest();
    lockFolderMock.mockClear();
    getActiveTabMock.mockReset();
    settingsStore.setAutoLockMinutes(15);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetForTest();
  });

  it("armAutoLock registers a timer; disarmAutoLock clears it", () => {
    attachAutoLockListeners({ vaultPath: "/vault", target: document });
    armAutoLock("secret", "/vault");
    expect(_getActiveTimers()).toEqual(["secret"]);
    disarmAutoLock("secret");
    expect(_getActiveTimers()).toEqual([]);
  });

  it("fires lockFolder after the configured timeout with no activity", async () => {
    attachAutoLockListeners({ vaultPath: "/vault", target: document });
    armAutoLock("secret", "/vault");
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(lockFolderMock).toHaveBeenCalledTimes(1);
    expect(lockFolderMock).toHaveBeenCalledWith("/vault/secret");
  });

  it("keydown activity on the configured tab resets the timer", async () => {
    attachAutoLockListeners({ vaultPath: "/vault", target: document });
    armAutoLock("secret", "/vault");
    // Active tab is a file inside the locked root — activity should
    // reset. Note: `getActiveTab` returns a tab-like record.
    getActiveTabMock.mockReturnValue({ filePath: "/vault/secret/note.md" });

    // Halfway through the timeout, simulate a keystroke.
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    // Debounce + schedule a fresh setTimeout — advance again by less
    // than the full timeout and assert nothing fired.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(lockFolderMock).not.toHaveBeenCalled();
    // Finally let the full timeout pass after the reset.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(lockFolderMock).toHaveBeenCalledTimes(1);
  });

  it("activity on a file OUTSIDE the locked root does not reset the timer", async () => {
    attachAutoLockListeners({ vaultPath: "/vault", target: document });
    armAutoLock("secret", "/vault");
    getActiveTabMock.mockReturnValue({ filePath: "/vault/plain/other.md" });
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(lockFolderMock).toHaveBeenCalledTimes(1);
  });

  it("resetAutoLockStore tears down timers and listeners", async () => {
    attachAutoLockListeners({ vaultPath: "/vault", target: document });
    armAutoLock("secret", "/vault");
    resetAutoLockStore();
    // Timer gone.
    expect(_getActiveTimers()).toEqual([]);
    // Even if time passes, no lock fires (listener detached).
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(lockFolderMock).not.toHaveBeenCalled();
  });

  it("setting autoLockMinutes to 0 disables the timer", async () => {
    attachAutoLockListeners({ vaultPath: "/vault", target: document });
    armAutoLock("secret", "/vault");
    settingsStore.setAutoLockMinutes(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(lockFolderMock).not.toHaveBeenCalled();
  });

  it("locks with the absolute path captured at arm time (survives vault switch)", async () => {
    attachAutoLockListeners({ vaultPath: "/vault-A", target: document });
    armAutoLock("secret", "/vault-A");
    // Vault switch mid-countdown. attachAutoLockListeners updates the
    // active root, but the armed timer must still fire against the
    // ORIGINAL abs path it was created with.
    attachAutoLockListeners({ vaultPath: "/vault-B", target: document });
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(lockFolderMock).toHaveBeenCalledWith("/vault-A/secret");
  });
});
