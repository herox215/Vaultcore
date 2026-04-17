// Frontend mirror of the Rust `VaultError` enum (src-tauri/src/error.rs).
// The Rust side serializes every variant as `{ kind, message, data }` via a
// hand-rolled `serde::Serialize` impl — any change here must stay in lock-step
// with `VaultError::variant_name` / `extra_data` in src-tauri/src/error.rs.

export type VaultErrorKind =
  | "FileNotFound"
  | "PermissionDenied"
  | "DiskFull"
  | "IndexCorrupt"
  | "IndexLocked"
  | "VaultUnavailable"
  | "MergeConflict"
  | "InvalidEncoding"
  | "Io";

export interface VaultError {
  kind: VaultErrorKind;
  message: string;
  data: string | null;
}

/** Runtime type guard — used at the IPC boundary to validate shapes. */
export function isVaultError(x: unknown): x is VaultError {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  return (
    typeof obj["kind"] === "string" &&
    typeof obj["message"] === "string" &&
    (obj["data"] === null || typeof obj["data"] === "string" || obj["data"] === undefined)
  );
}

/**
 * UI-SPEC copy map — single source of truth for error toast text.
 * Never interpolates raw filesystem paths (T-02-03 mitigation) except for
 * MergeConflict, where `data` is a vault-internal relative path.
 */
export function vaultErrorCopy(err: VaultError): string {
  switch (err.kind) {
    case "FileNotFound":
      return "Vault not found. The folder may have been moved or deleted.";
    case "PermissionDenied":
      return "Permission denied. VaultCore cannot read this folder.";
    case "DiskFull":
      return "Disk full. Could not save changes.";
    case "VaultUnavailable":
      return "Vault unavailable. Check that the folder is still mounted.";
    case "InvalidEncoding":
      return "Cannot open this file. It contains non-UTF-8 characters.";
    case "Io":
      return "File system error. Check the folder and try again.";
    case "IndexCorrupt":
      return "Index corrupt. VaultCore will rebuild it.";
    case "IndexLocked":
      return "Search index is in use by another window or a stuck VaultCore process. Close other instances or restart VaultCore.";
    case "MergeConflict":
      return `Conflict in ${err.data ?? "file"} — local version kept.`;
    default: {
      const _exhaustive: never = err.kind;
      return "An unexpected error occurred.";
    }
  }
}
