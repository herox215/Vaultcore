// snippetsStore — custom CSS snippets (#64).
//
// Holds the list of snippet filenames available in the current vault, the
// per-vault enabled set, and the CSS text of enabled snippets (lazy-loaded).
// Classic `writable` factory per D-06 / RC-01 — no `$state` runes.
//
// Persistence: the enabled set is keyed per vault in localStorage using a
// SHA-256 prefix of the vault path, identical to treeState (FILE-06/07).
// This keeps the "enabled here" choice local to each vault — opening a
// different vault doesn't silently inherit a previous vault's CSS.

import { writable, get } from "svelte/store";
import { listSnippets, readSnippet } from "../ipc/commands";
import { toastStore } from "./toastStore";
import { isVaultError, vaultErrorCopy } from "../types/errors";
import { vaultHashKey } from "../lib/treeState";

export interface SnippetsState {
  /** All `*.css` filenames found in `<vault>/.vaultcore/snippets/`, sorted. */
  available: string[];
  /** Filenames the user has toggled on for this vault. */
  enabled: string[];
  /** CSS text keyed by filename. Populated lazily when a snippet is enabled. */
  contents: Record<string, string>;
  loaded: boolean;
}

const initial: SnippetsState = {
  available: [],
  enabled: [],
  contents: {},
  loaded: false,
};

const _store = writable<SnippetsState>({ ...initial });

function pushError(e: unknown): void {
  const ve = isVaultError(e) ? e : { kind: "Io" as const, message: String(e), data: null };
  toastStore.push({ variant: "error", message: vaultErrorCopy(ve) });
}

async function enabledStorageKey(vaultPath: string): Promise<string> {
  // Reuse the vault-hash prefix helper so all per-vault keys share a common
  // scheme. `vaultHashKey` returns `vaultcore-tree-state:<hex>` — we swap
  // the namespace to `vaultcore-snippets-enabled:<hex>`.
  const treeKey = await vaultHashKey(vaultPath);
  return treeKey.replace(/^vaultcore-tree-state:/, "vaultcore-snippets-enabled:");
}

async function readEnabled(vaultPath: string): Promise<string[]> {
  try {
    const key = await enabledStorageKey(vaultPath);
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

async function writeEnabled(vaultPath: string, enabled: string[]): Promise<void> {
  try {
    const key = await enabledStorageKey(vaultPath);
    localStorage.setItem(key, JSON.stringify(enabled));
  } catch {
    /* private mode / quota — fall through silently */
  }
}

async function ensureLoaded(vaultPath: string, filename: string): Promise<void> {
  const cur = get(_store);
  if (cur.contents[filename] !== undefined) return;
  try {
    const css = await readSnippet(vaultPath, filename);
    _store.update((s) => ({ ...s, contents: { ...s.contents, [filename]: css } }));
  } catch (e) {
    // If read fails, strip it from the enabled set so we don't leave a
    // ghost style tag with empty content and keep retrying forever.
    _store.update((s) => ({ ...s, enabled: s.enabled.filter((n) => n !== filename) }));
    void writeEnabled(vaultPath, get(_store).enabled);
    pushError(e);
  }
}

export const snippetsStore = {
  subscribe: _store.subscribe,

  /**
   * Refresh `available` by re-scanning the vault, then preload any enabled
   * snippet whose text isn't cached yet. Called on vault open and whenever
   * the user hits "Reload" in Settings.
   */
  async load(vaultPath: string): Promise<void> {
    let available: string[] = [];
    try {
      available = await listSnippets(vaultPath);
    } catch (e) {
      pushError(e);
    }
    const persistedEnabled = await readEnabled(vaultPath);
    // Drop enabled entries whose files have vanished since last run.
    const enabled = persistedEnabled.filter((n) => available.includes(n));
    if (enabled.length !== persistedEnabled.length) {
      void writeEnabled(vaultPath, enabled);
    }
    _store.set({ available, enabled, contents: {}, loaded: true });
    // Lazily fetch CSS text for the currently-enabled ones so the DOM
    // <style> tags can render immediately.
    for (const name of enabled) {
      void ensureLoaded(vaultPath, name);
    }
  },

  async toggle(filename: string, vaultPath: string): Promise<void> {
    if (!filename) return;
    const current = get(_store);
    if (!current.available.includes(filename)) return;
    const isOn = current.enabled.includes(filename);
    const next = isOn
      ? current.enabled.filter((n) => n !== filename)
      : [...current.enabled, filename];
    _store.update((s) => ({ ...s, enabled: next }));
    await writeEnabled(vaultPath, next);
    if (!isOn) {
      await ensureLoaded(vaultPath, filename);
    }
  },

  reset(): void {
    _store.set({ ...initial });
  },
};
