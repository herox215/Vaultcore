// #345 — public view of an encrypted folder entry returned by
// `list_encrypted_folders`. Mirrors the Rust `EncryptedFolderView`.
// Salt is never surfaced to the frontend; the Rust side strips it
// before serde.

export type EncryptedFolderState = "encrypting" | "encrypted";

export interface EncryptedFolderView {
  /** Vault-relative path using forward slashes. */
  path: string;
  /** ISO-8601 UTC timestamp of the encrypt operation. */
  createdAt: string;
  /**
   * Current manifest state. `"encrypting"` marks a folder whose
   * encrypt batch was interrupted — the crash-resume flow (PR 345.3)
   * lets the user recover it.
   */
  state: EncryptedFolderState;
  /**
   * #351 — whether this root is currently locked in the running
   * session. Derived from the in-memory `locked_paths` registry at
   * list time; not persisted in the manifest. The frontend diffs
   * this across refreshes to detect unlocked → locked transitions
   * and close any open tabs that sit inside a now-locked root.
   */
  locked: boolean;
}

/** Progress payload for the `vault://encrypt_progress` event. */
export interface EncryptProgress {
  current: number;
  total: number;
  /** Absolute path of the file being sealed. */
  file: string;
}
