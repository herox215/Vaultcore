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

// ── Semantic search (#201) ──────────────────────────────────────────────────

export type ReindexPhase = "scan" | "index" | "done" | "cancelled";

export interface ReindexProgressPayload {
  done: number;
  total: number;
  skipped: number;
  embedded: number;
  phase: ReindexPhase;
  eta_seconds: number | null;
}

export const REINDEX_PROGRESS_EVENT = "embed://reindex_progress";

/**
 * #201: Subscribe to `embed://reindex_progress` events emitted by the
 * background reindex worker. One `scan` event fires on start (total=0),
 * one `index` event fires once the walk finishes (total=N, done=0), then
 * one per processed file, then a terminal `done` or `cancelled` event.
 */
export function listenReindexProgress(
  handler: (payload: ReindexProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<ReindexProgressPayload>(REINDEX_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
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
