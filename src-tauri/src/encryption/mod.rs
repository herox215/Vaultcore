// #345 — per-folder encryption at rest.
//
// Obsidian-compat note: ciphertext files under an encrypted folder are
// not readable by Obsidian, but the surrounding vault remains
// compatible. Users opt in per folder; the vault structure itself is
// untouched.
//
// Encryption scope per folder: every regular file, not only `.md`.
// Attachments (images pasted into notes, PDFs, CSV exports, canvas
// files) are sealed together with the notes they belong to — otherwise
// the "this folder is private" contract would silently leak through
// the embedded-asset side door.
//
// Crypto choices are frozen — see `crypto.rs` for rationale. Changing
// them requires a file-format magic bump (VCE1 → VCE2) and migration.
//
// Layout:
//   crypto.rs       — XChaCha20-Poly1305 + Argon2id primitives
//   file_format.rs  — on-disk container + atomic write
//   manifest.rs     — per-vault `.vaultcore/encrypted-folders.json`
//   registry.rs     — in-memory locked-path set + derived-key cache
//   batch.rs        — folder-level encrypt + lock + unlock helpers
//   (IPC commands live in `crate::commands::encryption`, following the
//    existing commands/{vault,files,search,…}.rs convention; encryption/
//    holds the domain primitives only.)

pub(crate) mod batch;
pub(crate) mod crypto;
pub(crate) mod file_format;
pub(crate) mod manifest;
pub(crate) mod registry;

// Public surface — kept intentionally narrow. PRs 1b/2/3 import only
// the state primitives (registry types + newtype) and the sentinel
// constants needed at module boundaries. Internal primitives like
// `encrypt_bytes`, `frame`, and `random_nonce` stay crate-private to
// prevent drift in future call sites.
pub use registry::{CanonicalPath, Keyring, LockedPathRegistry};

/// Name of the per-folder sentinel file that probes a candidate
/// unlock-password. It starts with `.` so walk_md_files / list_directory
/// naturally skip it.
pub const SENTINEL_FILENAME: &str = ".vaultcore-folder-key-check";

/// Deterministic plaintext sealed by the sentinel. Decrypting this with
/// a candidate key confirms (or denies) the password.
pub const SENTINEL_PLAINTEXT: &[u8] = b"VCE1-SENTINEL-v1";
