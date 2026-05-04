// Cross-component opener for the Settings modal.
//
// VaultLayout still owns the `open` state of the modal (via a local
// `$state` flag) — but components that need to *request* settings be
// opened from outside the layout (e.g. UI-4 SyncStatusPill error
// state, future toast actions) push into this store, and VaultLayout
// subscribes once and forwards to its local flag.
//
// The store carries an optional section anchor so callers can ask
// the modal to scroll to a specific section after open. VaultLayout
// resolves the anchor by looking up `[data-testid=settings-<anchor>]`
// once the modal is rendered.

import { writable } from "svelte/store";

export type SettingsAnchor = "sync" | null;

export interface SettingsModalRequest {
  /** Monotonic counter so the same anchor request twice in a row still
   *  triggers a fresh `open` (subscribers compare against the previous
   *  value reference). */
  seq: number;
  anchor: SettingsAnchor;
}

const internal = writable<SettingsModalRequest | null>(null);
let seq = 0;

export const settingsModalRequest = { subscribe: internal.subscribe };

export function requestOpenSettings(anchor: SettingsAnchor = null): void {
  internal.set({ seq: ++seq, anchor });
}

export function clearSettingsRequest(): void {
  internal.set(null);
}
