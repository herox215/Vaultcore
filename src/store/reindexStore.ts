/**
 * reindexStore — tracks the frontend-visible state of the #201 semantic
 * reindex worker. Subscribed to by `App.svelte`'s event listener (which
 * pipes `embed://reindex_progress` payloads into `apply`) and by the
 * statusbar widget that renders progress to the user.
 *
 * Kept deliberately small: the backend already holds the source of
 * truth (a resumable checkpoint + thread handle); the store only
 * exposes the latest payload plus a derived `inProgress` flag so the
 * statusbar can hide itself when idle.
 *
 * Pattern: classic writable factory. Do not refactor to Svelte 5
 * $state runes (same RC-01 constraint as settingsStore).
 */
import { writable } from "svelte/store";
import type { ReindexPhase, ReindexProgressPayload } from "../ipc/events";

export interface ReindexState {
  phase: ReindexPhase | "idle";
  done: number;
  total: number;
  skipped: number;
  embedded: number;
  etaSeconds: number | null;
}

const initial: ReindexState = {
  phase: "idle",
  done: 0,
  total: 0,
  skipped: 0,
  embedded: 0,
  etaSeconds: null,
};

function createReindexStore() {
  const _store = writable<ReindexState>({ ...initial });
  return {
    subscribe: _store.subscribe,
    /** Ingest one `embed://reindex_progress` payload. Maps the snake_case
     *  wire field to the camelCase `etaSeconds` for Svelte templates. */
    apply(payload: ReindexProgressPayload): void {
      _store.set({
        phase: payload.phase,
        done: payload.done,
        total: payload.total,
        skipped: payload.skipped,
        embedded: payload.embedded,
        etaSeconds: payload.eta_seconds,
      });
    },
    /** Reset to idle — used on vault switch or after acknowledging a
     *  `done`/`cancelled` terminal state so the statusbar retracts. */
    reset(): void {
      _store.set({ ...initial });
    },
  };
}

export const reindexStore = createReindexStore();

/** True while the worker is actively scanning or indexing (not idle,
 *  not terminal). Pure function so callers and tests can derive it
 *  without a store subscription. */
export function isActive(state: ReindexState): boolean {
  return state.phase === "scan" || state.phase === "index";
}
