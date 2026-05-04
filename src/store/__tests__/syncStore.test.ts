// UI-1 — unit tests for the syncStore.
//
// Coverage matrix:
//   1. `initSyncStore` populates identity / discoverable / paired peers.
//   2. Event handlers update the matching slice (peers-discovered,
//      peer-paired triggers re-fetch, sync-status keyed by vault_id,
//      stale-peer-resurrect appended to queue).
//   3. Optimistic actions roll back on backend error
//      (setDiscoverable, revokePeer, revokeVaultGrant).
//   4. Pairing flow: start → step → confirm clears the pending session.
//   5. `resetSyncStore` clears state and tears down listeners.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

vi.mock("../../ipc/commands", () => ({
  syncGetSelfIdentity: vi.fn(),
  syncSetDeviceName: vi.fn(),
  syncGetDiscoverable: vi.fn(),
  syncSetDiscoverable: vi.fn(),
  syncListDiscoveredPeers: vi.fn(),
  syncListPairedPeers: vi.fn(),
  syncPairingStartInitiator: vi.fn(),
  syncPairingStartResponder: vi.fn(),
  syncPairingStep: vi.fn(),
  syncPairingConfirm: vi.fn(),
  syncPairingCancel: vi.fn(),
  syncGrantVault: vi.fn(),
  syncRevokePeer: vi.fn(),
  syncRevokeVaultGrant: vi.fn(),
}));

vi.mock("../../ipc/events", () => ({
  listenPeersDiscovered: vi.fn(async () => () => {}),
  listenPeerPaired: vi.fn(async () => () => {}),
  listenSyncStatus: vi.fn(async () => () => {}),
  listenStalePeerResurrect: vi.fn(async () => () => {}),
}));

import {
  syncGetSelfIdentity,
  syncGetDiscoverable,
  syncSetDiscoverable,
  syncListPairedPeers,
  syncPairingStartInitiator,
  syncPairingStartResponder,
  syncPairingStep,
  syncPairingConfirm,
  syncPairingCancel,
  syncGrantVault,
  syncRevokePeer,
  syncRevokeVaultGrant,
} from "../../ipc/commands";
import {
  listenPeersDiscovered,
  listenPeerPaired,
  listenSyncStatus,
  listenStalePeerResurrect,
} from "../../ipc/events";

// Cast the mocks for typed access.
const m = {
  getIdentity: syncGetSelfIdentity as unknown as ReturnType<typeof vi.fn>,
  getDiscoverable: syncGetDiscoverable as unknown as ReturnType<typeof vi.fn>,
  setDiscoverable: syncSetDiscoverable as unknown as ReturnType<typeof vi.fn>,
  listPaired: syncListPairedPeers as unknown as ReturnType<typeof vi.fn>,
  startInitiator: syncPairingStartInitiator as unknown as ReturnType<typeof vi.fn>,
  startResponder: syncPairingStartResponder as unknown as ReturnType<typeof vi.fn>,
  step: syncPairingStep as unknown as ReturnType<typeof vi.fn>,
  confirm: syncPairingConfirm as unknown as ReturnType<typeof vi.fn>,
  cancel: syncPairingCancel as unknown as ReturnType<typeof vi.fn>,
  grant: syncGrantVault as unknown as ReturnType<typeof vi.fn>,
  revokePeer: syncRevokePeer as unknown as ReturnType<typeof vi.fn>,
  revokeGrant: syncRevokeVaultGrant as unknown as ReturnType<typeof vi.fn>,
  listenPeers: listenPeersDiscovered as unknown as ReturnType<typeof vi.fn>,
  listenPaired: listenPeerPaired as unknown as ReturnType<typeof vi.fn>,
  listenStatus: listenSyncStatus as unknown as ReturnType<typeof vi.fn>,
  listenStale: listenStalePeerResurrect as unknown as ReturnType<typeof vi.fn>,
};

import {
  initSyncStore,
  resetSyncStore,
  setDiscoverable,
  startInitiator,
  startResponder,
  stepPairing,
  confirmPairing,
  cancelPairing,
  grantVault,
  revokePeer,
  revokeVaultGrant,
  dismissResurrect,
  selfIdentity,
  discoverable,
  discoveredPeers,
  pairedPeers,
  syncStatusByVault,
  pendingPairingSession,
  staleResurrectQueue,
  syncStoreReady,
} from "../syncStore";

const sampleIdentity = {
  device_id: "ABCDEFGHIJKLMNOPQRSTUVWX",
  device_name: "Alice's Mac",
  pubkey_fingerprint: "ABCDEFGH",
};

describe("syncStore", () => {
  beforeEach(() => {
    Object.values(m).forEach((mock) => mock.mockReset());
    // Default: every listener returns a no-op unlisten.
    m.listenPeers.mockImplementation(async () => () => {});
    m.listenPaired.mockImplementation(async () => () => {});
    m.listenStatus.mockImplementation(async () => () => {});
    m.listenStale.mockImplementation(async () => () => {});
    resetSyncStore();
  });

  afterEach(() => {
    resetSyncStore();
  });

  // ─── init ──────────────────────────────────────────────────────────────

  it("initSyncStore populates identity / discoverable / pairedPeers and flips ready", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(true);
    m.listPaired.mockResolvedValue([
      {
        device_id: "PEER1",
        device_name: "Bob",
        last_seen: 1700_000_000,
        grants: [],
      },
    ]);
    expect(get(syncStoreReady)).toBe(false);
    await initSyncStore();
    expect(get(syncStoreReady)).toBe(true);
    expect(get(selfIdentity)).toEqual(sampleIdentity);
    expect(get(discoverable)).toBe(true);
    expect(get(pairedPeers)).toHaveLength(1);
    expect(get(pairedPeers)[0]!.device_id).toBe("PEER1");
  });

  it("initSyncStore tolerates a failing identity fetch", async () => {
    m.getIdentity.mockRejectedValue(new Error("keychain locked"));
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    await initSyncStore();
    expect(get(selfIdentity)).toBeNull();
    expect(get(syncStoreReady)).toBe(true);
  });

  it("initSyncStore subscribes to all four sync events", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    await initSyncStore();
    expect(m.listenPeers).toHaveBeenCalledTimes(1);
    expect(m.listenPaired).toHaveBeenCalledTimes(1);
    expect(m.listenStatus).toHaveBeenCalledTimes(1);
    expect(m.listenStale).toHaveBeenCalledTimes(1);
  });

  // ─── event-driven updates ──────────────────────────────────────────────

  it("peers-discovered event replaces discoveredPeers", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    let captured: ((p: any) => void) | null = null;
    m.listenPeers.mockImplementation(async (h: any) => {
      captured = h;
      return () => {};
    });
    await initSyncStore();
    expect(captured).not.toBeNull();
    captured!([
      { device_id: "P1", device_name: "X", vaults: [], addr: "1.2.3.4:17091" },
    ]);
    expect(get(discoveredPeers)).toHaveLength(1);
    captured!([]); // empty snapshot replaces the prior list
    expect(get(discoveredPeers)).toHaveLength(0);
  });

  it("peer-paired event triggers a paired-peers re-fetch", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        device_id: "FRESH",
        device_name: "Fresh",
        last_seen: null,
        grants: [],
      },
    ]);
    let captured: ((p: any) => void) | null = null;
    m.listenPaired.mockImplementation(async (h: any) => {
      captured = h;
      return () => {};
    });
    await initSyncStore();
    expect(get(pairedPeers)).toHaveLength(0);
    captured!({ device_id: "FRESH", device_name: "Fresh" });
    // Wait for the async refresh to complete.
    await Promise.resolve();
    await Promise.resolve();
    expect(get(pairedPeers)).toHaveLength(1);
    expect(get(pairedPeers)[0]!.device_id).toBe("FRESH");
  });

  it("sync-status events accumulate into syncStatusByVault keyed by vault_id", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    let captured: ((p: any) => void) | null = null;
    m.listenStatus.mockImplementation(async (h: any) => {
      captured = h;
      return () => {};
    });
    await initSyncStore();
    captured!({
      vault_id: "v1",
      peer_count: 1,
      in_flight_files: 3,
      error: null,
    });
    captured!({
      vault_id: "v2",
      peer_count: 0,
      in_flight_files: 0,
      error: "no peers reachable",
    });
    const status = get(syncStatusByVault);
    expect(status.v1!.peer_count).toBe(1);
    expect(status.v1!.in_flight_files).toBe(3);
    expect(status.v2!.error).toBe("no peers reachable");
    // Update v1: in_flight drops, no error.
    captured!({ vault_id: "v1", peer_count: 1, in_flight_files: 0, error: null });
    expect(get(syncStatusByVault).v1!.in_flight_files).toBe(0);
    // v2 untouched.
    expect(get(syncStatusByVault).v2!.error).toBe("no peers reachable");
  });

  it("stale-peer-resurrect events append to the queue with monotonic ids", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    let captured: ((p: any) => void) | null = null;
    m.listenStale.mockImplementation(async (h: any) => {
      captured = h;
      return () => {};
    });
    await initSyncStore();
    captured!({
      peer_device_id: "PEER1",
      peer_name: "Bob",
      pending_change_count: 4,
    });
    captured!({
      peer_device_id: "PEER1",
      peer_name: "Bob",
      pending_change_count: 5,
    });
    const queue = get(staleResurrectQueue);
    expect(queue).toHaveLength(2);
    expect(queue[0]!.id).toBe(1);
    expect(queue[1]!.id).toBe(2);
    // dismissResurrect removes every entry for that peer.
    dismissResurrect("PEER1");
    expect(get(staleResurrectQueue)).toHaveLength(0);
  });

  // ─── optimistic actions + rollback ─────────────────────────────────────

  it("setDiscoverable flips the local flag immediately and rolls back on error", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    await initSyncStore();
    expect(get(discoverable)).toBe(false);
    // Success path.
    m.setDiscoverable.mockResolvedValueOnce(undefined);
    await setDiscoverable(true);
    expect(get(discoverable)).toBe(true);
    expect(m.setDiscoverable).toHaveBeenCalledWith(true);
    // Failure path: prior value restored.
    m.setDiscoverable.mockRejectedValueOnce(new Error("daemon dead"));
    await expect(setDiscoverable(false)).rejects.toThrow("daemon dead");
    expect(get(discoverable)).toBe(true);
  });

  it("revokePeer optimistically removes the peer and restores on error", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([
      { device_id: "P1", device_name: "B", last_seen: null, grants: [] },
      { device_id: "P2", device_name: "C", last_seen: null, grants: [] },
    ]);
    await initSyncStore();
    expect(get(pairedPeers)).toHaveLength(2);
    m.revokePeer.mockRejectedValueOnce(new Error("nope"));
    await expect(revokePeer("P1")).rejects.toThrow("nope");
    // Rollback: P1 is back.
    expect(get(pairedPeers).map((p) => p.device_id)).toEqual(["P1", "P2"]);
    m.revokePeer.mockResolvedValueOnce(undefined);
    await revokePeer("P1");
    expect(get(pairedPeers).map((p) => p.device_id)).toEqual(["P2"]);
  });

  it("revokeVaultGrant optimistically drops the grant and restores on error", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([
      {
        device_id: "P1",
        device_name: "B",
        last_seen: null,
        grants: [
          { vault_id: "v1", vault_name: "v1", scope: "read+write" },
          { vault_id: "v2", vault_name: "v2", scope: "read" },
        ],
      },
    ]);
    await initSyncStore();
    m.revokeGrant.mockRejectedValueOnce(new Error("nope"));
    await expect(revokeVaultGrant("P1", "v1")).rejects.toThrow("nope");
    expect(get(pairedPeers)[0]!.grants).toHaveLength(2);
    m.revokeGrant.mockResolvedValueOnce(undefined);
    await revokeVaultGrant("P1", "v1");
    expect(get(pairedPeers)[0]!.grants.map((g) => g.vault_id)).toEqual(["v2"]);
  });

  // ─── pairing flow ──────────────────────────────────────────────────────

  it("startInitiator stores a pending session with PIN and expiry", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    await initSyncStore();
    m.startInitiator.mockResolvedValueOnce({
      session_id: "S1",
      pin: "654321",
      expires_at_unix: 1700_000_000,
    });
    const dto = await startInitiator();
    expect(dto.pin).toBe("654321");
    const pending = get(pendingPairingSession);
    expect(pending?.role).toBe("initiator");
    expect(pending?.pin).toBe("654321");
  });

  it("startResponder stores a pending responder session", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    await initSyncStore();
    m.startResponder.mockResolvedValueOnce({ session_id: "R1" });
    await startResponder("123456");
    const pending = get(pendingPairingSession);
    expect(pending?.role).toBe("responder");
    expect(pending?.pin).toBeNull();
    expect(m.startResponder).toHaveBeenCalledWith("123456");
  });

  it("stepPairing dispatches the right session id and stashes the result", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    await initSyncStore();
    m.startInitiator.mockResolvedValueOnce({
      session_id: "SID",
      pin: "111111",
      expires_at_unix: 0,
    });
    await startInitiator();
    m.step.mockResolvedValueOnce({
      kind: "awaiting_confirmation",
      peer_fingerprint: "ABCDEFGH",
      attempts_remaining: 3,
    });
    const step = await stepPairing();
    expect(step.kind).toBe("awaiting_confirmation");
    expect(m.step).toHaveBeenCalledWith("SID", undefined);
    expect(get(pendingPairingSession)?.last_step?.peer_fingerprint).toBe("ABCDEFGH");
  });

  it("stepPairing throws when no pending session exists", async () => {
    await expect(stepPairing()).rejects.toThrow("no pairing session");
  });

  it("confirmPairing clears the pending session and refreshes paired peers", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { device_id: "NEW", device_name: "n", last_seen: null, grants: [] },
    ]);
    await initSyncStore();
    m.startInitiator.mockResolvedValueOnce({
      session_id: "C1",
      pin: "1",
      expires_at_unix: 0,
    });
    await startInitiator();
    m.confirm.mockResolvedValueOnce(undefined);
    await confirmPairing();
    expect(get(pendingPairingSession)).toBeNull();
    expect(get(pairedPeers).map((p) => p.device_id)).toEqual(["NEW"]);
  });

  it("cancelPairing clears the pending session even if cancel command fails", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValue([]);
    await initSyncStore();
    m.startInitiator.mockResolvedValueOnce({
      session_id: "X",
      pin: "1",
      expires_at_unix: 0,
    });
    await startInitiator();
    m.cancel.mockRejectedValueOnce(new Error("backend gone"));
    // The store still clears the pending session (matches encryption-modal
    // pattern: the user clicked cancel; their intent is final regardless
    // of whether the backend ack came through).
    await cancelPairing();
    expect(get(pendingPairingSession)).toBeNull();
  });

  // ─── grants ────────────────────────────────────────────────────────────

  it("grantVault dispatches the command and refreshes the list", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(false);
    m.listPaired.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        device_id: "P1",
        device_name: "B",
        last_seen: null,
        grants: [{ vault_id: "v1", vault_name: "v1", scope: "read" }],
      },
    ]);
    await initSyncStore();
    m.grant.mockResolvedValueOnce(undefined);
    await grantVault("P1", "v1", "read");
    expect(m.grant).toHaveBeenCalledWith("P1", "v1", "read");
    expect(get(pairedPeers)[0]!.grants).toHaveLength(1);
  });

  // ─── reset ─────────────────────────────────────────────────────────────

  it("resetSyncStore clears state and tears down listeners", async () => {
    m.getIdentity.mockResolvedValue(sampleIdentity);
    m.getDiscoverable.mockResolvedValue(true);
    m.listPaired.mockResolvedValue([]);
    const unlistenA = vi.fn();
    const unlistenB = vi.fn();
    const unlistenC = vi.fn();
    const unlistenD = vi.fn();
    m.listenPeers.mockResolvedValueOnce(unlistenA);
    m.listenPaired.mockResolvedValueOnce(unlistenB);
    m.listenStatus.mockResolvedValueOnce(unlistenC);
    m.listenStale.mockResolvedValueOnce(unlistenD);
    await initSyncStore();
    expect(get(discoverable)).toBe(true);
    resetSyncStore();
    expect(unlistenA).toHaveBeenCalledTimes(1);
    expect(unlistenB).toHaveBeenCalledTimes(1);
    expect(unlistenC).toHaveBeenCalledTimes(1);
    expect(unlistenD).toHaveBeenCalledTimes(1);
    expect(get(syncStoreReady)).toBe(false);
    expect(get(discoverable)).toBe(false);
    expect(get(selfIdentity)).toBeNull();
  });
});
