// Cross-component opener for the PairingModal (UI-3). Settings →
// SYNCHRONISIERUNG section calls `openPairingModal()` to start a
// fresh pairing session, or `openPairingModal({ peer })` to pre-fill
// the modal with a peer the user just clicked in the discovered
// list. The PairingModal subscribes to this store and renders when
// the value is non-null.
//
// Mirrors `encryptionModalStore.ts` — keeps modal lifetime off the
// component that triggered the open (Settings can be torn down via
// Escape mid-pairing without aborting the flow).

import { writable } from "svelte/store";
import type { DiscoveredPeer } from "../ipc/commands";

export type PairingModalRequest = {
  /** When set, pre-fill the responder/initiator UI with this peer. */
  peer?: DiscoveredPeer;
} | null;

export const pairingModal = writable<PairingModalRequest>(null);

export function openPairingModal(peer?: DiscoveredPeer): void {
  pairingModal.set(peer ? { peer } : {});
}

export function closePairingModal(): void {
  pairingModal.set(null);
}
