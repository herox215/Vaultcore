// Frontend mirror of the Rust `DirEntry` struct (src-tauri/src/commands/tree.rs).
// Any change here must stay in lock-step with the Rust struct definition.

/**
 * #345 — encryption state of a folder node. Kebab-case serde on the
 * Rust side (`"not-encrypted"` / `"locked"` / `"unlocked"`). Files
 * always carry `"not-encrypted"`; only directory rows vary.
 */
export type EncryptionState = "not-encrypted" | "locked" | "unlocked";

export interface DirEntry {
  name: string;
  path: string;       // Absolute path (canonicalized by Rust backend)
  is_dir: boolean;
  is_symlink: boolean;
  is_md: boolean;     // true for .md extension
  /** Seconds since UNIX_EPOCH; null if metadata unavailable. */
  modified: number | null;
  /** Seconds since UNIX_EPOCH; null on Linux ext4 or if metadata unavailable. */
  created: number | null;
  /**
   * #345 — kebab-case from Rust. Optional in the TS mirror for
   * backwards-compat with pre-#345 test fixtures: production code
   * coming from Rust always has this field set. Callers that need to
   * branch should default `undefined` to `"not-encrypted"` via
   * `encryptionOf(entry)`.
   */
  encryption?: EncryptionState;
}

/** Default-aware accessor for the #345 encryption field. */
export function encryptionOf(entry: Pick<DirEntry, "encryption">): EncryptionState {
  return entry.encryption ?? "not-encrypted";
}
