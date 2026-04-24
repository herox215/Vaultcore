/**
 * #357 — live state for the auto-encrypt-on-drop status pill.
 *
 * Mirrors `reindexStore` on purpose: classic `writable` factory, no
 * Svelte 5 runes (same RC-01 constraint), one `.set()` per payload.
 * The 3-second auto-dismiss timer lives in the consuming component,
 * not here — matches `ReindexStatusbar` and keeps the store free of
 * `window.setTimeout` so SSR / test environments stay happy.
 */
import { writable } from "svelte/store";

import type { EncryptDropProgressPayload } from "../ipc/events";

export interface EncryptionProgressState {
  /** Count of files still being sealed in the current batch. The
   *  backend is synchronous today so this is always 0 on emit, but the
   *  field is reserved for a future streaming-encrypt follow-up. */
  inFlight: number;
  /** Count of files sealed so far in the current batch. Used by the
   *  pill's "N file(s) secured." label. */
  total: number;
  /** Last sealed (or queued) file path — feeds the pill's detail text
   *  and the `queued` threat-model toast copy. */
  lastCompleted: string | null;
  /** `true` when the most recent event was a queue-into-locked-folder
   *  notification. Triggers the user-facing warning toast: "File
   *  queued — remains unencrypted on disk until you unlock the folder."
   */
  queued: boolean;
  /** Per-file error from the backend when sealing failed. Persists
   *  until the next success payload (mirrors the Vitruvius brief). */
  error: { path: string; message: string } | null;
  /** Controls the pill's render gate. `true` while the pill is on
   *  screen; the component flips this back to `false` after the
   *  auto-dismiss timer elapses. */
  visible: boolean;
}

const initial: EncryptionProgressState = {
  inFlight: 0,
  total: 0,
  lastCompleted: null,
  queued: false,
  error: null,
  visible: false,
};

function createEncryptionProgressStore() {
  const _store = writable<EncryptionProgressState>({ ...initial });
  return {
    subscribe: _store.subscribe,
    /** Ingest one `vault://encrypt_drop_progress` payload. Errors
     *  replace any prior state (we do not stack). Success payloads
     *  accumulate the sealed count so the pill renders "N file(s)
     *  secured." after a bulk drop. */
    apply(payload: EncryptDropProgressPayload): void {
      _store.update((prev) => {
        if (payload.error) {
          return {
            inFlight: 0,
            total: prev.total,
            lastCompleted: prev.lastCompleted,
            queued: false,
            error: payload.error,
            visible: true,
          };
        }
        const added = payload.total ?? 0;
        return {
          inFlight: payload.inFlight ?? 0,
          total: prev.total + added,
          lastCompleted: payload.lastCompleted ?? prev.lastCompleted,
          queued: !!payload.queued,
          error: null,
          visible: true,
        };
      });
    },
    /** Hide the pill and clear the current batch. The component calls
     *  this after its 3 s auto-dismiss timer fires. */
    reset(): void {
      _store.set({ ...initial });
    },
  };
}

export const encryptionProgressStore = createEncryptionProgressStore();
