// #345 — unit tests for the encryptedFoldersStore.
//
// The store exposes two derived streams (`encryptedFolders`,
// `encryptedPaths`) backed by a fetch against `list_encrypted_folders`
// and driven by the `vault://encrypted_folders_changed` event. We
// cover: init populates, reset clears, and the synthetic test setter
// works as expected.
//
// #351 adds: on refresh, detect unlocked→locked transitions (diff the
// `locked` flag across snapshots) and close any open tabs whose file
// path falls under the newly-locked root.

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
import { tabLifecycleStore } from "../tabLifecycleStore";
import { _reset as _resetTabs } from "../tabStoreCore";
import { vaultStore } from "../vaultStore";

describe("encryptedFoldersStore", () => {
  beforeEach(() => {
    listEncryptedFoldersMock.mockReset();
    listenEncryptedFoldersChangedMock.mockClear();
    resetEncryptedFoldersStore();
    _resetTabs();
  });

  afterEach(() => {
    resetEncryptedFoldersStore();
    _resetTabs();
  });

  it("starts empty and not-ready", () => {
    expect(get(encryptedFolders)).toEqual([]);
    expect(get(encryptedFoldersReady)).toBe(false);
    expect(get(encryptedPaths).size).toBe(0);
  });

  it("populates after initEncryptedFoldersStore() resolves", async () => {
    listEncryptedFoldersMock.mockResolvedValue([
      { path: "secret", createdAt: "2026-04-23T00:00:00Z", state: "encrypted", locked: true },
      { path: "journal", createdAt: "2026-04-23T00:00:00Z", state: "encrypted", locked: true },
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
      { path: "x", createdAt: "t", state: "encrypted", locked: true },
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

  // #351 — tab-close on folder lock.
  describe("#351 tab closure on lock transition", () => {
    /**
     * Seed vaultStore with a root and return a fake unlisten capturing
     * the event handler so we can drive it synchronously in tests.
     */
    function captureEventHandler(): { fire: () => Promise<void> } {
      let captured: (() => void) | null = null;
      listenEncryptedFoldersChangedMock.mockImplementationOnce(
        async (h: () => void) => {
          captured = h;
          return () => {};
        },
      );
      return {
        fire: async () => {
          if (!captured) throw new Error("handler not yet registered");
          captured();
          // Event handler kicks off async work — let the microtask queue drain.
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        },
      };
    }

    function setVaultRoot(root: string): void {
      vaultStore.setReady({ currentPath: root, fileList: [], fileCount: 0 });
    }

    it("does NOT close tabs on initial populate, even if folders are locked", async () => {
      // A persisted-session scenario: the user had `/vault/secret/a.md`
      // open when the app was quit; on re-open the manifest says `secret`
      // is locked (new sessions always start locked per #345). The store
      // must seed its previous-locked snapshot WITHOUT diffing against
      // an empty set — otherwise every initial locked root would close
      // its open tabs on vault open.
      setVaultRoot("/vault");
      tabLifecycleStore.openTab("/vault/secret/a.md");
      listEncryptedFoldersMock.mockResolvedValue([
        { path: "secret", createdAt: "t", state: "encrypted", locked: true },
      ]);
      await initEncryptedFoldersStore();
      expect(get(tabLifecycleStore).tabs).toHaveLength(1);
    });

    it("closes tabs under a folder that transitions unlocked → locked", async () => {
      setVaultRoot("/vault");
      tabLifecycleStore.openTab("/vault/secret/a.md");
      tabLifecycleStore.openTab("/vault/secret/sub/b.md");
      const keep = tabLifecycleStore.openTab("/vault/other/c.md");
      // Initial snapshot: `secret` is unlocked.
      const { fire } = captureEventHandler();
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "secret", createdAt: "t", state: "encrypted", locked: false },
      ]);
      await initEncryptedFoldersStore();
      expect(get(tabLifecycleStore).tabs).toHaveLength(3);
      // Next refresh: `secret` is now locked.
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "secret", createdAt: "t", state: "encrypted", locked: true },
      ]);
      await fire();
      const state = get(tabLifecycleStore);
      expect(state.tabs.map((t) => t.id)).toEqual([keep]);
    });

    it("leaves tabs alone when a folder transitions locked → unlocked", async () => {
      setVaultRoot("/vault");
      // First snapshot: locked. Tabs should not close (seeded previous).
      const { fire } = captureEventHandler();
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "secret", createdAt: "t", state: "encrypted", locked: true },
      ]);
      await initEncryptedFoldersStore();
      tabLifecycleStore.openTab("/vault/other/a.md");
      // User unlocks; new refresh shows locked=false. Nothing to close.
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "secret", createdAt: "t", state: "encrypted", locked: false },
      ]);
      await fire();
      expect(get(tabLifecycleStore).tabs).toHaveLength(1);
    });

    it("closes only tabs under the newly-locked folder, not under already-locked ones", async () => {
      setVaultRoot("/vault");
      tabLifecycleStore.openTab("/vault/journal/x.md");
      tabLifecycleStore.openTab("/vault/secret/y.md");
      // Initial snapshot: journal locked, secret unlocked.
      const { fire } = captureEventHandler();
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "journal", createdAt: "t", state: "encrypted", locked: true },
        { path: "secret", createdAt: "t", state: "encrypted", locked: false },
      ]);
      await initEncryptedFoldersStore();
      // After seed: both tabs still open (journal tab was already there
      // when we seeded; we do not retroactively close on seed).
      expect(get(tabLifecycleStore).tabs).toHaveLength(2);
      // Lock secret. Journal stays locked — should NOT re-trigger close.
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "journal", createdAt: "t", state: "encrypted", locked: true },
        { path: "secret", createdAt: "t", state: "encrypted", locked: true },
      ]);
      await fire();
      const state = get(tabLifecycleStore);
      const paths = state.tabs.map((t) => t.filePath);
      // journal/x.md survives (still open from before — it was never re-locked
      // in our tracked deltas); secret/y.md is closed.
      expect(paths).toContain("/vault/journal/x.md");
      expect(paths).not.toContain("/vault/secret/y.md");
    });

    it("leaves previous snapshot unchanged when the refresh IPC fails", async () => {
      setVaultRoot("/vault");
      tabLifecycleStore.openTab("/vault/secret/a.md");
      // Seed: unlocked.
      const { fire } = captureEventHandler();
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "secret", createdAt: "t", state: "encrypted", locked: false },
      ]);
      await initEncryptedFoldersStore();
      // Transient failure — don't mutate previous set, don't close tabs.
      listEncryptedFoldersMock.mockRejectedValueOnce(new Error("boom"));
      await fire();
      expect(get(tabLifecycleStore).tabs).toHaveLength(1);
      // Recovery: next successful refresh still sees the unlocked→locked
      // delta and closes the tab.
      listEncryptedFoldersMock.mockResolvedValueOnce([
        { path: "secret", createdAt: "t", state: "encrypted", locked: true },
      ]);
      await fire();
      expect(get(tabLifecycleStore).tabs).toHaveLength(0);
    });
  });
});
