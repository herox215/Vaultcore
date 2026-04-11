// Typed IPC layer — the ONLY place in the frontend that imports `invoke`.
// Components and stores MUST go through these wrappers so:
//   1. Every Tauri error surfaces as a normalized `VaultError` (T-02-02).
//   2. The T-02 vault-scope guard on the Rust side cannot be bypassed by a
//      component calling `invoke` directly with an arbitrary path (T-02-01).

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { VaultError } from "../types/errors";
import { isVaultError } from "../types/errors";
import type { VaultInfo, VaultStats, RecentVault } from "../types/vault";

function normalizeError(err: unknown): VaultError {
  if (isVaultError(err)) {
    // Guarantee `data` is `string | null`, never `undefined`, so downstream
    // discriminated-union matching never hits an unreachable branch.
    return { kind: err.kind, message: err.message, data: err.data ?? null };
  }
  return {
    kind: "Io",
    message: typeof err === "string" ? err : String(err),
    data: null,
  };
}

/** VAULT-01: native folder dialog. Returns `null` when the user cancels. */
export async function pickVaultFolder(): Promise<string | null> {
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: "Open vault",
  });
  if (picked === null) return null;
  if (Array.isArray(picked)) return picked[0] ?? null;
  return picked;
}

export async function openVault(path: string): Promise<VaultInfo> {
  try {
    return await invoke<VaultInfo>("open_vault", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function getRecentVaults(): Promise<RecentVault[]> {
  try {
    return await invoke<RecentVault[]>("get_recent_vaults");
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function getVaultStats(path: string): Promise<VaultStats> {
  try {
    return await invoke<VaultStats>("get_vault_stats", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function readFile(path: string): Promise<string> {
  try {
    return await invoke<string>("read_file", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function writeFile(path: string, content: string): Promise<string> {
  try {
    return await invoke<string>("write_file", { path, content });
  } catch (e) {
    throw normalizeError(e);
  }
}
