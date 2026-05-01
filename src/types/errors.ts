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
  | "LockPoisoned"
  | "Io"
  // #345 — encrypted-folder error variants.
  | "PathLocked"
  | "WrongPassword"
  | "CryptoError"
  // #391 — picker (NSOpenPanel / GTK file chooser / Android SAF) failed.
  // Cancellation is signalled via `null` from the picker wrappers; this
  // variant carries genuine errors only.
  | "PickerFailed"
  // #392 — request resolved outside the vault root (T-02 violation).
  // Either a client bug or attack — never user-actionable.
  | "PathOutsideVault"
  // #392 PR-B — SAF tree URI no longer has a persisted permission grant.
  // Frontend listens for this kind in the loadVault error path and
  // routes through pickVaultFolder() to re-grant access.
  | "VaultPermissionRevoked"
  // #392 PR-B — encrypted folders aren't yet supported on Android.
  // Tracked: #345 storage-trait-aware encryption follow-up.
  | "EncryptionUnsupportedOnAndroid";

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
    case "LockPoisoned":
      return "Internal error — please restart VaultCore.";
    case "MergeConflict":
      return `Conflict in ${err.data ?? "file"} — local version kept.`;
    case "PathLocked":
      return "This folder is locked. Unlock it before reading or editing its files.";
    case "WrongPassword":
      return "Wrong password.";
    case "CryptoError":
      return "Encryption error. This file may be corrupted or from a newer VaultCore version.";
    case "PickerFailed":
      return "Could not open the file picker. Please try again.";
    case "PathOutsideVault":
      return "Request denied — the path is outside the vault.";
    case "VaultPermissionRevoked":
      return "Vault access was revoked. Tap to re-pick the folder.";
    case "EncryptionUnsupportedOnAndroid":
      return "Encrypted folders aren't yet supported on Android.";
    default: {
      const _exhaustive: never = err.kind;
      return "An unexpected error occurred.";
    }
  }
}
