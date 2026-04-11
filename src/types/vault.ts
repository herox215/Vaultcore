// Frontend mirror of the Rust types defined in src-tauri/src/commands/vault.rs.
// Field names use snake_case because the Rust structs are `#[derive(Serialize)]`
// without a `#[serde(rename_all)]` attribute — the IPC boundary sees raw
// snake_case keys.

export interface VaultInfo {
  path: string;
  file_count: number;
}

export interface VaultStats {
  path: string;
  file_count: number;
}

export interface RecentVault {
  path: string;
  last_opened: string;
}

/** UI state machine for the current vault lifecycle. */
export type VaultStatus = "idle" | "opening" | "indexing" | "ready" | "error";
