// Typed Tauri event listeners — the ONLY place in the frontend that imports
// `listen` from `@tauri-apps/api/event`. Mirrors the pattern in commands.ts.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface IndexProgressPayload {
  current: number;
  total: number;
  current_file: string;
}

export const INDEX_PROGRESS_EVENT = "vault://index_progress";

/**
 * IDX-02: Subscribe to vault://index_progress events emitted by the Rust
 * two-pass walk in open_vault. Returns an unlisten handle.
 */
export function listenIndexProgress(
  handler: (payload: IndexProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<IndexProgressPayload>(INDEX_PROGRESS_EVENT, (event) => {
    handler(event.payload);
  });
}

// --- Phase 2 events ---------------------------------------------------------

export interface FileChangePayload {
  path: string;
  kind: "create" | "modify" | "delete" | "rename";
  new_path?: string;
}

export interface VaultStatusPayload {
  reachable: boolean;
}

export interface BulkChangePayload {
  estimated_count: number;
}

export const FILE_CHANGE_EVENT = "vault://file_changed";
export const VAULT_STATUS_EVENT = "vault://vault_status";
export const BULK_CHANGE_START_EVENT = "vault://bulk_change_start";
export const BULK_CHANGE_END_EVENT = "vault://bulk_change_end";

/**
 * SYNC-01: Subscribe to vault://file_changed events emitted by the file watcher
 * when an external change is detected.
 */
export function listenFileChange(
  handler: (payload: FileChangePayload) => void,
): Promise<UnlistenFn> {
  return listen<FileChangePayload>(FILE_CHANGE_EVENT, (event) => handler(event.payload));
}

/**
 * ERR-03: Subscribe to vault://vault_status events emitted when the vault
 * folder becomes unreachable (unmounted) or reachable again.
 */
export function listenVaultStatus(
  handler: (payload: VaultStatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<VaultStatusPayload>(VAULT_STATUS_EVENT, (event) => handler(event.payload));
}

/**
 * SYNC-05: Subscribe to vault://bulk_change_start events emitted when >500
 * file events arrive in a 2-second window — triggers the progress UI.
 */
export function listenBulkChangeStart(
  handler: (payload: BulkChangePayload) => void,
): Promise<UnlistenFn> {
  return listen<BulkChangePayload>(BULK_CHANGE_START_EVENT, (event) => handler(event.payload));
}

/**
 * SYNC-05: Subscribe to vault://bulk_change_end events emitted when the bulk
 * change burst subsides — dismisses the progress UI.
 */
export function listenBulkChangeEnd(handler: () => void): Promise<UnlistenFn> {
  return listen(BULK_CHANGE_END_EVENT, () => handler());
}

// ── #345 — encrypted folders ────────────────────────────────────────────────

export interface EncryptProgressPayload {
  current: number;
  total: number;
  file: string;
}

export const ENCRYPT_PROGRESS_EVENT = "vault://encrypt_progress";
export const ENCRYPTED_FOLDERS_CHANGED_EVENT = "vault://encrypted_folders_changed";

/**
 * #345: progress stream for the `encrypt_folder` batch. One event per
 * 50 ms while sealing files. Not emitted for small folders (< 16
 * files) — the round-trip latency dominates at that scale.
 */
export function listenEncryptProgress(
  handler: (payload: EncryptProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<EncryptProgressPayload>(ENCRYPT_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * #345: single-pulse event fired after encrypt / unlock / lock /
 * lock_all_folders mutate the registry or manifest. The frontend
 * `encryptedFoldersStore` refreshes on every pulse.
 */
export function listenEncryptedFoldersChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(ENCRYPTED_FOLDERS_CHANGED_EVENT, () => handler());
}

// ── #357 — auto-encrypt-on-drop live progress ──────────────────────────────

export interface EncryptDropProgressPayload {
  /** Files still being sealed in the current batch. Synchronous
   *  backend → always 0 today; reserved for streaming follow-up. */
  inFlight: number;
  /** Files sealed in this event's batch. Feeds the pill counter. */
  total: number;
  /** Last sealed (or queued) path — null for pure error payloads. */
  lastCompleted: string | null;
  /** `true` when the drop landed in a locked folder and was queued
   *  for seal-on-unlock. Distinct UI copy: the file is plaintext on
   *  disk until the user unlocks. */
  queued: boolean;
  /** Per-file error — persists the pill in error state until the user
   *  acts. A toast fires alongside for actionable detail. */
  error: { path: string; message: string } | null;
}

export const ENCRYPT_DROP_PROGRESS_EVENT = "vault://encrypt_drop_progress";

/**
 * #357 — subscribe to the auto-encrypt-on-drop live progress stream.
 * Fires per debounced watcher batch (Sealed) and per unlock drain
 * (Sealed / Queued) and per failure. Frontend routes payloads through
 * `encryptionProgressStore.apply`; errors also surface as a separate
 * `toastStore.error` so the user sees the failed filename.
 */
export function listenEncryptDropProgress(
  handler: (payload: EncryptDropProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<EncryptDropProgressPayload>(ENCRYPT_DROP_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
}

// ── UI-1 — sync events ────────────────────────────────────────────────────
//
// Four typed event channels emitted by `commands::sync_cmds::SyncRuntime`.
// `peers-discovered` is debounced 250 ms server-side; everything else
// fires once per state transition. Frontend stores must not poll any
// `sync_*` command on a timer — the contract is event-driven.

import type { DiscoveredPeer } from "./commands";

export interface PeerPairedPayload {
  device_id: string;
  device_name: string;
}

/** Per-vault sync status. `error` is populated on the first transport
 *  failure for a vault; cleared on the next successful sync. */
export interface SyncStatusPayload {
  vault_id: string;
  peer_count: number;
  in_flight_files: number;
  error: string | null;
}

/** Stale-peer resurrection: a previously paired peer reappears with
 *  pending changes. UI-5 surfaces this as a persistent toast. */
export interface StalePeerResurrectPayload {
  peer_device_id: string;
  peer_name: string;
  pending_change_count: number;
}

export const PEERS_DISCOVERED_EVENT = "sync://peers-discovered";
export const PEER_PAIRED_EVENT = "sync://peer-paired";
export const SYNC_STATUS_EVENT = "sync://sync-status";
export const STALE_PEER_RESURRECT_EVENT = "sync://stale-peer-resurrect";

export function listenPeersDiscovered(
  handler: (payload: DiscoveredPeer[]) => void,
): Promise<UnlistenFn> {
  return listen<DiscoveredPeer[]>(PEERS_DISCOVERED_EVENT, (event) =>
    handler(event.payload),
  );
}

export function listenPeerPaired(
  handler: (payload: PeerPairedPayload) => void,
): Promise<UnlistenFn> {
  return listen<PeerPairedPayload>(PEER_PAIRED_EVENT, (event) => handler(event.payload));
}

export function listenSyncStatus(
  handler: (payload: SyncStatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<SyncStatusPayload>(SYNC_STATUS_EVENT, (event) => handler(event.payload));
}

export function listenStalePeerResurrect(
  handler: (payload: StalePeerResurrectPayload) => void,
): Promise<UnlistenFn> {
  return listen<StalePeerResurrectPayload>(STALE_PEER_RESURRECT_EVENT, (event) =>
    handler(event.payload),
  );
}
