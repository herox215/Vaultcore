// UI-1 — frontend store for the LAN sync IPC bridge.
//
// Mirrors `commands::sync_cmds::SyncRuntime` on the Rust side. The store
// holds five independent slices (identity, discoverable toggle,
// discovered-peer list, paired-peer list, per-vault sync status), plus
// two queue-shaped slices for in-flight pairing flows and stale-peer
// resurrect prompts.
//
// Update strategy:
// - `init()` runs once at app bootstrap. It fetches the initial
//   identity / discoverable / paired-peers state and subscribes to all
//   four `sync://*` events. Subsequent changes arrive exclusively via
//   events; the store NEVER polls a `sync_*` command on a timer.
// - User actions (toggle discoverable, start pairing, grant vault,
//   etc.) dispatch a command and apply an optimistic update. On error
//   the optimistic update rolls back and the error is rethrown so the
//   caller can render it (toast / inline / modal — store-level code is
//   purpose-agnostic).
//
// Why optimistic on `setDiscoverable`: the toggle is the most-clicked
// surface in Settings, and waiting ~50 ms for the round-trip on every
// click feels laggy. Other actions (pairing, grants) are explicit
// confirmation flows where the user expects a brief spinner — those
// dispatch the command first and update state from the response.

import { writable, derived, get, type Readable } from "svelte/store";

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
  syncPairingGrantVault,
  syncRevokePeer,
  syncRevokeVaultGrant,
  type SelfIdentity,
  type DiscoveredPeer,
  type PairedPeer,
  type PairingStartInitiator,
  type PairingStartResponder,
  type PairingStep,
} from "../ipc/commands";
import {
  listenPeersDiscovered,
  listenPeerPaired,
  listenSyncStatus,
  listenStalePeerResurrect,
  type SyncStatusPayload,
  type StalePeerResurrectPayload,
} from "../ipc/events";

export type PairingSessionRole = "initiator" | "responder";

export interface PendingPairingSession {
  session_id: string;
  role: PairingSessionRole;
  /** Initiator only — the 6-digit PIN displayed to the user. */
  pin: string | null;
  /** Initiator only — Unix seconds at which the PIN expires. */
  expires_at_unix: number | null;
  /** Latest poll of the state machine; null until the first step()
   *  has returned. */
  last_step: PairingStep | null;
}

export interface StaleResurrectEntry extends StalePeerResurrectPayload {
  /** Monotonic id assigned client-side so duplicate-peer events
   *  produce a queue entry per occurrence rather than collapsing. */
  id: number;
}

interface SyncStoreState {
  selfIdentity: SelfIdentity | null;
  discoverable: boolean;
  discoveredPeers: DiscoveredPeer[];
  pairedPeers: PairedPeer[];
  /** Keyed by `vault_id`. Cleared per-vault when a `peer_count = 0` and
   *  no `error` arrives — i.e. the steady empty state. */
  syncStatusByVault: Record<string, SyncStatusPayload>;
  pendingPairingSession: PendingPairingSession | null;
  staleResurrectQueue: StaleResurrectEntry[];
  /** True once `init()` has finished its initial fetches. UI shells
   *  bind on this to render skeletons during cold start. */
  ready: boolean;
}

const initialState: SyncStoreState = {
  selfIdentity: null,
  discoverable: false,
  discoveredPeers: [],
  pairedPeers: [],
  syncStatusByVault: {},
  pendingPairingSession: null,
  staleResurrectQueue: [],
  ready: false,
};

const internal = writable<SyncStoreState>({ ...initialState });

let unlistenFns: Array<() => void> = [];
let staleSeq = 0;

// ─── Derived selectors ─────────────────────────────────────────────────────

export const selfIdentity: Readable<SelfIdentity | null> = derived(
  internal,
  ($s) => $s.selfIdentity,
);

export const discoverable: Readable<boolean> = derived(internal, ($s) => $s.discoverable);

export const discoveredPeers: Readable<DiscoveredPeer[]> = derived(
  internal,
  ($s) => $s.discoveredPeers,
);

export const pairedPeers: Readable<PairedPeer[]> = derived(
  internal,
  ($s) => $s.pairedPeers,
);

export const syncStatusByVault: Readable<Record<string, SyncStatusPayload>> = derived(
  internal,
  ($s) => $s.syncStatusByVault,
);

export const pendingPairingSession: Readable<PendingPairingSession | null> = derived(
  internal,
  ($s) => $s.pendingPairingSession,
);

export const staleResurrectQueue: Readable<StaleResurrectEntry[]> = derived(
  internal,
  ($s) => $s.staleResurrectQueue,
);

export const syncStoreReady: Readable<boolean> = derived(internal, ($s) => $s.ready);

// ─── Internals ─────────────────────────────────────────────────────────────

function patch(p: Partial<SyncStoreState>): void {
  internal.update((s) => ({ ...s, ...p }));
}

async function refreshPairedPeers(): Promise<void> {
  try {
    const peers = await syncListPairedPeers();
    patch({ pairedPeers: peers });
  } catch (e) {
    // Don't throw — list_paired_peers can transiently fail (e.g. SQLite
    // open race during vault switch). Last-known state remains; the
    // next event-driven fetch will recover.
    // eslint-disable-next-line no-console
    console.warn("syncStore: refreshPairedPeers failed", e);
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────

/** Run once at app bootstrap. Fetches initial identity + discoverable +
 *  paired-peers, then subscribes to the four `sync://*` events. */
export async function initSyncStore(): Promise<void> {
  // Tear down any previous subscriptions (HMR / test resets).
  for (const f of unlistenFns) {
    try {
      f();
    } catch {
      /* swallow */
    }
  }
  unlistenFns = [];

  // Initial fetches in parallel — they're independent and a slow
  // mDNS daemon should not block the identity card render.
  const [identityRes, discoverableRes, pairedRes] = await Promise.allSettled([
    syncGetSelfIdentity(),
    syncGetDiscoverable(),
    syncListPairedPeers(),
  ]);

  patch({
    selfIdentity:
      identityRes.status === "fulfilled" ? identityRes.value : null,
    discoverable:
      discoverableRes.status === "fulfilled" ? discoverableRes.value : false,
    pairedPeers: pairedRes.status === "fulfilled" ? pairedRes.value : [],
    ready: true,
  });

  try {
    unlistenFns.push(
      await listenPeersDiscovered((peers) => {
        patch({ discoveredPeers: peers });
      }),
    );
    unlistenFns.push(
      await listenPeerPaired(() => {
        // Re-fetch the paired list rather than splice the event payload —
        // a confirmed peer also needs its (initially empty) grants array
        // surfaced, which only the full query returns.
        void refreshPairedPeers();
      }),
    );
    unlistenFns.push(
      await listenSyncStatus((status) => {
        internal.update((s) => ({
          ...s,
          syncStatusByVault: {
            ...s.syncStatusByVault,
            [status.vault_id]: status,
          },
        }));
      }),
    );
    unlistenFns.push(
      await listenStalePeerResurrect((payload) => {
        const entry: StaleResurrectEntry = { ...payload, id: ++staleSeq };
        internal.update((s) => ({
          ...s,
          staleResurrectQueue: [...s.staleResurrectQueue, entry],
        }));
      }),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("syncStore: subscribe failed", e);
  }
}

/** Tear down event listeners. Used by tests; production typically
 *  keeps the store live for the whole app lifetime. */
export function resetSyncStore(): void {
  for (const f of unlistenFns) {
    try {
      f();
    } catch {
      /* swallow */
    }
  }
  unlistenFns = [];
  staleSeq = 0;
  internal.set({ ...initialState });
}

/** Toggle the "Discoverable on this network" preference. Optimistic:
 *  the local flag flips immediately; on backend failure the prior
 *  value is restored and the error rethrown. */
export async function setDiscoverable(on: boolean): Promise<void> {
  const previous = get(internal).discoverable;
  patch({ discoverable: on });
  try {
    await syncSetDiscoverable(on);
  } catch (e) {
    patch({ discoverable: previous });
    throw e;
  }
}

export async function setDeviceName(name: string): Promise<void> {
  const previous = get(internal).selfIdentity;
  // Optimistic update on the cached identity.
  if (previous) {
    patch({ selfIdentity: { ...previous, device_name: name } });
  }
  try {
    const { syncSetDeviceName } = await import("../ipc/commands");
    await syncSetDeviceName(name);
  } catch (e) {
    patch({ selfIdentity: previous });
    throw e;
  }
}

export async function startInitiator(): Promise<PairingStartInitiator> {
  const dto = await syncPairingStartInitiator();
  patch({
    pendingPairingSession: {
      session_id: dto.session_id,
      role: "initiator",
      pin: dto.pin,
      expires_at_unix: dto.expires_at_unix,
      last_step: null,
    },
  });
  return dto;
}

export async function startResponder(
  pin: string,
  peerDeviceId?: string,
  peerAddr?: string,
): Promise<PairingStartResponder> {
  const dto = await syncPairingStartResponder(pin, peerDeviceId, peerAddr);
  patch({
    pendingPairingSession: {
      session_id: dto.session_id,
      role: "responder",
      pin: null,
      expires_at_unix: null,
      last_step: null,
    },
  });
  return dto;
}

export async function stepPairing(payload?: string): Promise<PairingStep> {
  const session = get(internal).pendingPairingSession;
  if (!session) {
    throw new Error("no pairing session in progress");
  }
  const step = await syncPairingStep(session.session_id, payload);
  patch({
    pendingPairingSession: { ...session, last_step: step },
  });
  return step;
}

export async function confirmPairing(): Promise<void> {
  const session = get(internal).pendingPairingSession;
  if (!session) {
    throw new Error("no pairing session in progress");
  }
  await syncPairingConfirm(session.session_id);
  patch({ pendingPairingSession: null });
  // The peer-paired event handler will refresh the list, but call it
  // here too so the UI doesn't depend on event arrival timing.
  await refreshPairedPeers();
}

export async function cancelPairing(): Promise<void> {
  const session = get(internal).pendingPairingSession;
  if (!session) return;
  // The user clicked Cancel; their intent is final. We notify the
  // backend but swallow errors — even if the backend ack fails the
  // local session is gone from the user's perspective. Matches the
  // encryption-modal cancel idiom.
  try {
    await syncPairingCancel(session.session_id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("syncStore: cancel pairing backend error", e);
  }
  patch({ pendingPairingSession: null });
}

export async function grantVault(
  peerDeviceId: string,
  vaultId: string,
  scope: "read" | "read+write",
): Promise<void> {
  await syncGrantVault(peerDeviceId, vaultId, scope);
  await refreshPairedPeers();
}

/**
 * Issue a vault grant inside an active pairing session. Routes through
 * the pairing engine's open Noise channel — both sides must be in step
 * 4 of their respective PairingModal flows simultaneously, since the
 * underlying engine call is symmetric and blocks waiting for the peer.
 */
export async function pairingGrantVault(
  vaultId: string,
  scope: "read" | "read+write",
): Promise<void> {
  const session = get(internal).pendingPairingSession;
  if (!session) {
    throw new Error("pairingGrantVault: no active pairing session");
  }
  await syncPairingGrantVault(session.session_id, vaultId, scope);
  await refreshPairedPeers();
}

export async function revokePeer(peerDeviceId: string): Promise<void> {
  // Optimistic: remove from the visible list immediately. Restore on error.
  const previous = get(internal).pairedPeers;
  patch({ pairedPeers: previous.filter((p) => p.device_id !== peerDeviceId) });
  try {
    await syncRevokePeer(peerDeviceId);
  } catch (e) {
    patch({ pairedPeers: previous });
    throw e;
  }
}

export async function revokeVaultGrant(
  peerDeviceId: string,
  vaultId: string,
): Promise<void> {
  const previous = get(internal).pairedPeers;
  patch({
    pairedPeers: previous.map((p) =>
      p.device_id === peerDeviceId
        ? { ...p, grants: p.grants.filter((g) => g.vault_id !== vaultId) }
        : p,
    ),
  });
  try {
    await syncRevokeVaultGrant(peerDeviceId, vaultId);
  } catch (e) {
    patch({ pairedPeers: previous });
    throw e;
  }
}

/** UI-5 hook: dismiss a stale-peer-resurrect entry once the user has
 *  acted (accepted resync or declined). */
export function dismissResurrect(peerDeviceId: string): void {
  internal.update((s) => ({
    ...s,
    staleResurrectQueue: s.staleResurrectQueue.filter(
      (e) => e.peer_device_id !== peerDeviceId,
    ),
  }));
}

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Test-only: snapshot the underlying internal state. */
export function _getStateForTest(): SyncStoreState {
  return get(internal);
}

/** Test-only: directly set state. */
export function _setStateForTest(patch: Partial<SyncStoreState>): void {
  internal.update((s) => ({ ...s, ...patch }));
}
