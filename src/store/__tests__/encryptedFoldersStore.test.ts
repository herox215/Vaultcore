// #345 — unit tests for the encryptedFoldersStore.
//
// The store exposes two derived streams (`encryptedFolders`,
// `encryptedPaths`) backed by a fetch against `list_encrypted_folders`
// and driven by the `vault://encrypted_folders_changed` event. We
// cover: init populates, reset clears, and the synthetic test setter
// works as expected.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

vi.mock("../../ipc/commands", () => ({
  listEncryptedFolders: vi.fn(),
}));

vi.mock("../../ipc/events", () => ({
  listenEncryptedFoldersChanged: vi.fn(async () => () => {}),
}));

import { listEncryptedFolders } from "../../ipc/commands";
import { listenEncryptedFoldersChanged } from "../../ipc/events";

const listEncryptedFoldersMock = listEncryptedFolders as unknown as ReturnType<typeof vi.fn>;
const listenEncryptedFoldersChangedMock = listenEncryptedFoldersChanged as unknown as ReturnType<typeof vi.fn>;

import {
  _setEncryptedFoldersForTest,
  encryptedFolders,
  encryptedFoldersReady,
  encryptedPaths,
  initEncryptedFoldersStore,
  resetEncryptedFoldersStore,
} from "../encryptedFoldersStore";

describe("encryptedFoldersStore", () => {
  beforeEach(() => {
    listEncryptedFoldersMock.mockReset();
    listenEncryptedFoldersChangedMock.mockClear();
    resetEncryptedFoldersStore();
  });

  afterEach(() => {
    resetEncryptedFoldersStore();
  });

  it("starts empty and not-ready", () => {
    expect(get(encryptedFolders)).toEqual([]);
    expect(get(encryptedFoldersReady)).toBe(false);
    expect(get(encryptedPaths).size).toBe(0);
  });

  it("populates after initEncryptedFoldersStore() resolves", async () => {
    listEncryptedFoldersMock.mockResolvedValue([
      { path: "secret", createdAt: "2026-04-23T00:00:00Z", state: "encrypted" },
      { path: "journal", createdAt: "2026-04-23T00:00:00Z", state: "encrypted" },
    ]);
    await initEncryptedFoldersStore();
    expect(get(encryptedFolders)).toHaveLength(2);
    expect(get(encryptedFoldersReady)).toBe(true);
    const paths = get(encryptedPaths);
    expect(paths.has("secret")).toBe(true);
    expect(paths.has("journal")).toBe(true);
  });

  it("tears down the previous subscription before attaching a new one", async () => {
    // Regression guard for the lifecycle contract: re-initing the
    // store must call the unlisten handle returned by the PRIOR
    // subscribe call, then install a fresh listener. Without the
    // teardown we would leak subscriptions on every vault switch.
    listEncryptedFoldersMock.mockResolvedValue([]);
    const unlistenA = vi.fn();
    const unlistenB = vi.fn();
    listenEncryptedFoldersChangedMock
      .mockResolvedValueOnce(unlistenA)
      .mockResolvedValueOnce(unlistenB);
    await initEncryptedFoldersStore();
    expect(unlistenA).not.toHaveBeenCalled();
    await initEncryptedFoldersStore();
    // The SECOND init must invoke the FIRST unlisten before attaching.
    expect(unlistenA).toHaveBeenCalledTimes(1);
    expect(unlistenB).not.toHaveBeenCalled();
    // And reset() calls the latest unlisten.
    resetEncryptedFoldersStore();
    expect(unlistenB).toHaveBeenCalledTimes(1);
  });

  it("resetEncryptedFoldersStore clears state", () => {
    _setEncryptedFoldersForTest([
      { path: "x", createdAt: "t", state: "encrypted" },
    ]);
    expect(get(encryptedFolders)).toHaveLength(1);
    resetEncryptedFoldersStore();
    expect(get(encryptedFolders)).toEqual([]);
    expect(get(encryptedFoldersReady)).toBe(false);
  });

  it("survives a transient listEncryptedFolders failure", async () => {
    listEncryptedFoldersMock.mockRejectedValueOnce(new Error("boom"));
    await initEncryptedFoldersStore();
    // Still flagged not-ready because the fetch failed; next event tries
    // again.
    expect(get(encryptedFoldersReady)).toBe(false);
    expect(get(encryptedFolders)).toEqual([]);
  });
});
