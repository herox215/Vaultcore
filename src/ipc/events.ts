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
