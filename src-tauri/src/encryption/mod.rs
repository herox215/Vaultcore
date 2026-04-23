// #345 — per-folder encryption at rest.
//
// Obsidian-compat note: ciphertext .md files under an encrypted folder
// are not readable by Obsidian, but the surrounding vault remains
// compatible. Users opt in per folder; the vault structure itself is
// untouched.
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

pub mod batch;
pub mod crypto;
pub mod file_format;
pub mod manifest;
pub mod registry;

pub use registry::{Keyring, LockedPathRegistry};

/// Name of the per-folder sentinel file that probes a candidate
/// unlock-password. It starts with `.` so walk_md_files / list_directory
/// naturally skip it.
pub const SENTINEL_FILENAME: &str = ".vaultcore-folder-key-check";

/// Deterministic plaintext sealed by the sentinel. Decrypting this with
/// a candidate key confirms (or denies) the password.
pub const SENTINEL_PLAINTEXT: &[u8] = b"VCE1-SENTINEL-v1";
