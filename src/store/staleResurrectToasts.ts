// UI-5 — bridge: syncStore.staleResurrectQueue → persistent toast.
//
// A previously paired peer that comes back online with > 30 days of
// drift surfaces in syncStore.staleResurrectQueue (UI-1 wires the
// `sync://stale-peer-resurrect` event into the queue). For each NEW
// entry we push a persistent warning toast carrying:
//
//   - role="alert" / aria-live="assertive"   (immediate announce)
//   - persist: true                          (decision 3 — never auto-dismiss)
//   - action "Überprüfen"                    (opens Settings → SYNC, scoped)
//
// The toast's ✕ button only closes the toast; the peer remains in
// syncStore.staleResurrectQueue until handled in Settings (caller of
// onOpenSyncSettings is responsible for dispatching dismissResurrect()
// once the user accepts or declines the resync).

import { staleResurrectQueue, type StaleResurrectEntry } from "./syncStore";
import { toastStore } from "./toastStore";

export interface StaleResurrectToastsOptions {
  /** Invoked when the user clicks "Überprüfen". Receives the peer's
   *  device id so the consumer can scope the SYNC settings panel to
   *  that peer. UI-2 (settings-engineer) owns the actual modal-open
   *  side; this module just bridges the click. */
  onOpenSyncSettings?: (peerDeviceId: string) => void;
}

let unsubscribe: (() => void) | null = null;
let seenIds = new Set<number>();
let onOpen: ((peerDeviceId: string) => void) | null = null;

function buildMessage(entry: StaleResurrectEntry): string {
  return `${entry.peer_name} war über 30 Tage offline — ${entry.pending_change_count} ausstehende Änderungen prüfen?`;
}

function pushToastFor(entry: StaleResurrectEntry): void {
  toastStore.push({
    variant: "warning",
    message: buildMessage(entry),
    persist: true,
    role: "alert",
    ariaLive: "assertive",
    action: {
      label: "Überprüfen",
      onClick: () => {
        onOpen?.(entry.peer_device_id);
      },
    },
  });
}

/** Start watching the syncStore queue. Idempotent — calling twice
 *  replaces the previous subscription. Safe to call after
 *  initSyncStore() at app bootstrap. */
export function initStaleResurrectToasts(
  options: StaleResurrectToastsOptions = {},
): void {
  resetStaleResurrectToasts();
  onOpen = options.onOpenSyncSettings ?? null;
  unsubscribe = staleResurrectQueue.subscribe((queue) => {
    for (const entry of queue) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      pushToastFor(entry);
    }
  });
}

/** Tear down the subscription and forget which entries we've already
 *  surfaced. Used by tests; production keeps the bridge live for the
 *  whole app lifetime. */
export function resetStaleResurrectToasts(): void {
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* swallow */
    }
  }
  unsubscribe = null;
  seenIds = new Set<number>();
  onOpen = null;
}
