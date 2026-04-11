---
phase: 01-skeleton
plan: 01
type: execute
wave: 1
depends_on:
  - "01-skeleton/00"
files_modified:
  - src-tauri/src/error.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/commands/mod.rs
  - src-tauri/src/commands/vault.rs
  - src-tauri/src/commands/files.rs
  - src-tauri/src/hash.rs
  - src-tauri/src/tests/error_serialize.rs
  - src-tauri/src/tests/vault_stats.rs
autonomous: true
requirements:
  - VAULT-01
  - VAULT-02
  - VAULT-04
  - VAULT-05
  - VAULT-06
  - ERR-01
must_haves:
  truths:
    - "`VaultError` enum contains all 8 spec §5 variants and serializes to `{kind, message, data}`"
    - "`open_vault` canonicalizes the user path and grants runtime fs scope only to that directory"
    - "`read_file` returns `VaultError::InvalidEncoding` for non-UTF-8 bytes (D-17) and never loads them into a String"
    - "`write_file` refuses paths outside the currently-open vault (T-02 mitigation)"
    - "`recent_vaults` JSON round-trips, caps at 10, dedupes by path, evicts oldest"
    - "Every cargo test stub created in Wave 0 now executes and passes"
  artifacts:
    - path: "src-tauri/src/error.rs"
      provides: "Full VaultError enum with manual Serialize impl"
      contains: "InvalidEncoding"
    - path: "src-tauri/src/commands/vault.rs"
      provides: "open_vault, get_recent_vaults, get_vault_stats commands"
      exports: ["open_vault", "get_recent_vaults", "get_vault_stats"]
    - path: "src-tauri/src/commands/files.rs"
      provides: "read_file, write_file commands with UTF-8 guard and vault-scope guard"
      exports: ["read_file", "write_file"]
    - path: "src-tauri/src/hash.rs"
      provides: "SHA-256 content hashing helper for EDIT-10 groundwork"
  key_links:
    - from: "src-tauri/src/commands/vault.rs::open_vault"
      to: "tauri_plugin_fs::FsExt::allow_directory"
      via: "runtime scope expansion"
      pattern: "allow_directory"
    - from: "src-tauri/src/commands/files.rs::read_file"
      to: "VaultError::InvalidEncoding"
      via: "String::from_utf8 error branch"
      pattern: "InvalidEncoding"
    - from: "src-tauri/src/lib.rs"
      to: "commands::vault + commands::files"
      via: "invoke_handler macro"
      pattern: "generate_handler!"
---

<objective>
Build the Rust backend spine: the full `VaultError` enum per spec §5, the three `vault.rs` commands (`open_vault`, `get_recent_vaults`, `get_vault_stats`), the two `files.rs` commands (`read_file`, `write_file`) with D-17 UTF-8 rejection and T-02 vault-scope guard, the SHA-256 hash helper for EDIT-10 groundwork, and the runtime `FsExt::allow_directory` fs scope expansion (RESEARCH §1.5 / §8 Risk 1). Fill in every `#[ignore]` test stub from Wave 0 so cargo test goes green across ERR-01, VAULT-02, VAULT-04, VAULT-05, and VAULT-06.

Purpose: Every frontend plan (Wave 2+) depends on these command signatures. Getting them correct here — with structured error serialization, vault-scoped write guards, and UTF-8 enforcement at the read boundary — means downstream plans can treat the backend as a contract.

Output: A Rust backend that a Svelte frontend can invoke for all five commands, with red→green test coverage for every REQ-ID in this plan's requirements field.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/01-skeleton/01-CONTEXT.md
@.planning/phases/01-skeleton/01-RESEARCH.md
@.planning/phases/01-skeleton/01-VALIDATION.md
@.planning/phases/01-skeleton/01-00-SUMMARY.md
@VaultCore_MVP_Spezifikation_v3.md
@src-tauri/Cargo.toml
@src-tauri/src/lib.rs
@src-tauri/src/error.rs
@src-tauri/src/commands/mod.rs
@src-tauri/src/commands/vault.rs
@src-tauri/src/commands/files.rs
@src-tauri/src/tests/error_serialize.rs
@src-tauri/src/tests/vault_stats.rs

<interfaces>
<!-- Command signatures this plan publishes — Wave 2 frontend consumes these verbatim. -->

// src-tauri/src/commands/vault.rs
#[derive(serde::Serialize)]
pub struct VaultInfo {
    pub path: String,
    pub file_count: usize,
}

#[derive(serde::Serialize)]
pub struct VaultStats {
    pub path: String,
    pub file_count: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct RecentVault {
    pub path: String,
    pub last_opened: String, // ISO-8601
}

#[tauri::command]
pub async fn open_vault(app: tauri::AppHandle, path: String) -> Result<VaultInfo, VaultError>;

#[tauri::command]
pub async fn get_recent_vaults(app: tauri::AppHandle) -> Result<Vec<RecentVault>, VaultError>;

#[tauri::command]
pub async fn get_vault_stats(path: String) -> Result<VaultStats, VaultError>;

// src-tauri/src/commands/files.rs
#[tauri::command]
pub async fn read_file(
    state: tauri::State<'_, crate::VaultState>,
    path: String,
) -> Result<String, VaultError>;

#[tauri::command]
pub async fn write_file(
    state: tauri::State<'_, crate::VaultState>,
    path: String,
    content: String,
) -> Result<String, VaultError>; // returns SHA-256 hash of written bytes

// Frontend receives VaultError as:
//   { kind: "FileNotFound" | "PermissionDenied" | "DiskFull" | "IndexCorrupt"
//          | "VaultUnavailable" | "MergeConflict" | "InvalidEncoding" | "Io",
//     message: string,
//     data: string | null }
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Full VaultError enum with manual Serialize impl + ERR-01 tests green</name>
  <files>src-tauri/src/error.rs, src-tauri/src/tests/error_serialize.rs</files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §2.1 VaultError (complete code sample)
    - .planning/phases/01-skeleton/01-CONTEXT.md D-17 (InvalidEncoding pulled forward)
    - VaultCore_MVP_Spezifikation_v3.md §5 (full variant list in German)
    - src-tauri/src/error.rs (current Wave 0 placeholder)
    - src-tauri/src/tests/error_serialize.rs (current #[ignore] stubs)
  </read_first>
  <behavior>
    - FileNotFound { path } → serializes to `{ kind: "FileNotFound", message: "File not found: {path}", data: "{path}" }`
    - PermissionDenied { path } → `{ kind: "PermissionDenied", ... data: path }`
    - DiskFull → `{ kind: "DiskFull", message: "Disk full", data: null }`
    - IndexCorrupt → `{ kind: "IndexCorrupt", ... data: null }`
    - VaultUnavailable { path } → `{ kind: "VaultUnavailable", ... data: path }`
    - MergeConflict { path } → `{ kind: "MergeConflict", ... data: path }`
    - InvalidEncoding { path } → `{ kind: "InvalidEncoding", ... data: path }`
    - Io(std::io::Error) → `{ kind: "Io", message: "IO error: {inner}", data: null }`
    - `From<std::io::Error>` is implemented via `#[from]`
  </behavior>
  <action>
    Replace `src-tauri/src/error.rs` with the complete implementation from RESEARCH §2.1:

    ```rust
    use serde::ser::SerializeStruct;

    #[derive(Debug, thiserror::Error)]
    pub enum VaultError {
        #[error("File not found: {path}")]
        FileNotFound { path: String },

        #[error("Permission denied: {path}")]
        PermissionDenied { path: String },

        #[error("Disk full")]
        DiskFull,

        #[error("Index corrupt, rebuild needed")]
        IndexCorrupt,

        #[error("Vault unavailable: {path}")]
        VaultUnavailable { path: String },

        #[error("Merge conflict: {path}")]
        MergeConflict { path: String },

        #[error("File is not UTF-8: {path}")]
        InvalidEncoding { path: String },

        #[error("IO error: {0}")]
        Io(#[from] std::io::Error),
    }

    impl VaultError {
        pub fn variant_name(&self) -> &'static str {
            match self {
                Self::FileNotFound { .. } => "FileNotFound",
                Self::PermissionDenied { .. } => "PermissionDenied",
                Self::DiskFull => "DiskFull",
                Self::IndexCorrupt => "IndexCorrupt",
                Self::VaultUnavailable { .. } => "VaultUnavailable",
                Self::MergeConflict { .. } => "MergeConflict",
                Self::InvalidEncoding { .. } => "InvalidEncoding",
                Self::Io(_) => "Io",
            }
        }

        pub fn extra_data(&self) -> Option<String> {
            match self {
                Self::FileNotFound { path }
                | Self::PermissionDenied { path }
                | Self::VaultUnavailable { path }
                | Self::MergeConflict { path }
                | Self::InvalidEncoding { path } => Some(path.clone()),
                _ => None,
            }
        }
    }

    impl serde::Serialize for VaultError {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            let mut state = serializer.serialize_struct("VaultError", 3)?;
            state.serialize_field("kind", &self.variant_name())?;
            state.serialize_field("message", &self.to_string())?;
            state.serialize_field("data", &self.extra_data())?;
            state.end()
        }
    }
    ```

    Then fill in every ERR-01 test in `src-tauri/src/tests/error_serialize.rs` by removing `#[ignore]` and asserting the serialized JSON shape via `serde_json::to_value`:

    ```rust
    use crate::error::VaultError;
    use serde_json::{json, Value};

    fn to_json(err: VaultError) -> Value {
        serde_json::to_value(err).unwrap()
    }

    #[test]
    fn vault_error_serialize_file_not_found() {
        let v = to_json(VaultError::FileNotFound { path: "/a/b.md".into() });
        assert_eq!(v["kind"], "FileNotFound");
        assert_eq!(v["message"], "File not found: /a/b.md");
        assert_eq!(v["data"], "/a/b.md");
    }

    #[test]
    fn vault_error_serialize_permission_denied() {
        let v = to_json(VaultError::PermissionDenied { path: "/a".into() });
        assert_eq!(v["kind"], "PermissionDenied");
        assert_eq!(v["data"], "/a");
    }

    #[test]
    fn vault_error_serialize_disk_full() {
        let v = to_json(VaultError::DiskFull);
        assert_eq!(v["kind"], "DiskFull");
        assert_eq!(v["data"], Value::Null);
    }

    #[test]
    fn vault_error_serialize_index_corrupt() {
        let v = to_json(VaultError::IndexCorrupt);
        assert_eq!(v["kind"], "IndexCorrupt");
        assert_eq!(v["data"], Value::Null);
    }

    #[test]
    fn vault_error_serialize_vault_unavailable() {
        let v = to_json(VaultError::VaultUnavailable { path: "/x".into() });
        assert_eq!(v["kind"], "VaultUnavailable");
        assert_eq!(v["data"], "/x");
    }

    #[test]
    fn vault_error_serialize_merge_conflict() {
        let v = to_json(VaultError::MergeConflict { path: "/y".into() });
        assert_eq!(v["kind"], "MergeConflict");
        assert_eq!(v["data"], "/y");
    }

    #[test]
    fn vault_error_serialize_invalid_encoding() {
        let v = to_json(VaultError::InvalidEncoding { path: "/z.bin".into() });
        assert_eq!(v["kind"], "InvalidEncoding");
        assert_eq!(v["data"], "/z.bin");
    }

    #[test]
    fn vault_error_serialize_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::Other, "boom");
        let v = to_json(VaultError::from(io_err));
        assert_eq!(v["kind"], "Io");
        assert_eq!(v["data"], Value::Null);
        // message contains the io::Error display
        assert!(v["message"].as_str().unwrap().contains("boom"));
    }
    ```
  </action>
  <verify>
    <automated>cd src-tauri &amp;&amp; cargo test vault_error_serialize</automated>
  </verify>
  <acceptance_criteria>
    - `src-tauri/src/error.rs` contains all eight variants: `FileNotFound`, `PermissionDenied`, `DiskFull`, `IndexCorrupt`, `VaultUnavailable`, `MergeConflict`, `InvalidEncoding`, `Io`
    - `grep -c "impl serde::Serialize for VaultError" src-tauri/src/error.rs` returns 1
    - `grep -c "#\[from\] std::io::Error" src-tauri/src/error.rs` returns 1
    - `src-tauri/src/tests/error_serialize.rs` does NOT contain `#[ignore]`
    - `cargo test --manifest-path src-tauri/Cargo.toml vault_error_serialize` exits 0 with 8 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml vault_error_serialize 2>&1 | grep -c "test result: ok. 8 passed"` returns 1
  </acceptance_criteria>
  <done>ERR-01 complete — enum matches spec §5, serializes to `{kind, message, data}`, all 8 unit tests pass.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: vault.rs commands + recent-vaults JSON + VaultState with SHA-256 helper</name>
  <files>src-tauri/src/commands/vault.rs, src-tauri/src/hash.rs, src-tauri/src/lib.rs, src-tauri/src/tests/vault_stats.rs</files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §1.4 plugin registration, §1.5 capabilities + FsExt, §2.2 event emission, §4.1 walkdir filtering, §4.3 SHA-256, §4.4 recent-vaults JSON, §8 Risk 1 (FsExt::allow_directory)
    - .planning/phases/01-skeleton/01-CONTEXT.md D-21/D-22 (real file-walk progress), D-23 (recent-vaults schema, cap 10)
    - .planning/phases/01-skeleton/01-UI-SPEC.md "Progress UI" (event cadence: every 250 files OR 100ms)
    - src-tauri/src/commands/vault.rs (Wave 0 placeholder)
    - src-tauri/src/lib.rs (Wave 0 builder)
  </read_first>
  <behavior>
    - `get_vault_stats("/tmp/foo")` → walks `.md` files, skips dot-dirs, returns `{ path, file_count }`
    - `open_vault("/missing/path")` → returns `VaultError::VaultUnavailable { path: "/missing/path" }`
    - `open_vault("/real/path")` → canonicalizes path, calls `FsExt::allow_directory(&canonical, true)`, stores the canonical path in `VaultState`, pushes to recent-vaults JSON, returns `VaultInfo`
    - `get_recent_vaults()` → reads `recent-vaults.json` from `app.path().app_data_dir()`, returns `Vec<RecentVault>` or empty on missing file
    - Recent-vaults pusher caps at 10 entries, dedupes by path (removes duplicate then prepends), sorted by most-recent-first
    - Dot-directories (`.git`, `.obsidian`, anything starting with `.`) are skipped in the walk
  </behavior>
  <action>
    1. **Create `src-tauri/src/hash.rs`** (EDIT-10 groundwork per D-19):
       ```rust
       use sha2::{Digest, Sha256};

       /// SHA-256 of the given bytes as a lowercase hex string.
       /// Used to establish the hash-write pattern that Phase 5 EDIT-10
       /// will use for pre-save on-disk hash verification.
       pub fn hash_bytes(content: &[u8]) -> String {
           format!("{:x}", Sha256::digest(content))
       }

       #[cfg(test)]
       mod tests {
           use super::*;

           #[test]
           fn hash_empty_matches_known_value() {
               // Known SHA-256 of empty input
               assert_eq!(
                   hash_bytes(b""),
                   "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
               );
           }

           #[test]
           fn hash_changes_with_content() {
               assert_ne!(hash_bytes(b"a"), hash_bytes(b"b"));
           }
       }
       ```

    2. **Add `VaultState` to `src-tauri/src/lib.rs`:**
       ```rust
       pub mod error;
       pub mod commands;
       pub mod hash;

       #[cfg(test)]
       mod tests;

       use std::sync::Mutex;

       /// Holds the currently-open vault path (canonicalized) so that
       /// read_file / write_file can refuse paths outside the vault (T-02).
       #[derive(Default)]
       pub struct VaultState {
           pub current_vault: Mutex<Option<std::path::PathBuf>>,
       }

       pub fn run() {
           env_logger::init();
           tauri::Builder::default()
               .plugin(tauri_plugin_dialog::init())
               .plugin(tauri_plugin_fs::init())
               .manage(VaultState::default())
               .invoke_handler(tauri::generate_handler![
                   commands::vault::open_vault,
                   commands::vault::get_recent_vaults,
                   commands::vault::get_vault_stats,
                   commands::files::read_file,
                   commands::files::write_file,
               ])
               .run(tauri::generate_context!())
               .expect("error running tauri application");
       }
       ```

    3. **Write `src-tauri/src/commands/vault.rs`:**
       ```rust
       use crate::error::VaultError;
       use serde::{Deserialize, Serialize};
       use std::path::{Path, PathBuf};
       use tauri::{AppHandle, Manager};
       use tauri_plugin_fs::FsExt;
       use walkdir::{DirEntry, WalkDir};

       #[derive(Serialize, Clone)]
       pub struct VaultInfo {
           pub path: String,
           pub file_count: usize,
       }

       #[derive(Serialize, Clone)]
       pub struct VaultStats {
           pub path: String,
           pub file_count: usize,
       }

       #[derive(Serialize, Deserialize, Clone, Debug)]
       pub struct RecentVault {
           pub path: String,
           pub last_opened: String,
       }

       #[derive(Serialize, Deserialize, Default)]
       struct RecentVaultsFile {
           vaults: Vec<RecentVault>,
       }

       const MAX_RECENT: usize = 10;
       const RECENT_VAULTS_FILENAME: &str = "recent-vaults.json";

       fn is_excluded(entry: &DirEntry) -> bool {
           let name = entry.file_name().to_str().unwrap_or("");
           entry.depth() > 0 && name.starts_with('.')
       }

       pub fn count_md_files(root: &Path) -> usize {
           WalkDir::new(root)
               .follow_links(false)
               .into_iter()
               .filter_entry(|e| !is_excluded(e))
               .filter_map(|e| e.ok())
               .filter(|e| {
                   e.file_type().is_file()
                       && e.path().extension().map_or(false, |ext| ext == "md")
               })
               .count()
       }

       #[tauri::command]
       pub async fn get_vault_stats(path: String) -> Result<VaultStats, VaultError> {
           let p = PathBuf::from(&path);
           if !p.exists() {
               return Err(VaultError::VaultUnavailable { path });
           }
           if !p.is_dir() {
               return Err(VaultError::VaultUnavailable { path });
           }
           let file_count = count_md_files(&p);
           Ok(VaultStats { path, file_count })
       }

       #[tauri::command]
       pub async fn open_vault(
           app: AppHandle,
           state: tauri::State<'_, crate::VaultState>,
           path: String,
       ) -> Result<VaultInfo, VaultError> {
           let p = PathBuf::from(&path);
           // Canonicalize to block symlink escape + resolve `..` (T-01 mitigation)
           let canonical = std::fs::canonicalize(&p).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::VaultUnavailable { path: path.clone() },
               std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
               _ => VaultError::Io(e),
           })?;
           if !canonical.is_dir() {
               return Err(VaultError::VaultUnavailable { path });
           }

           // Grant runtime fs scope to this directory (RESEARCH §1.5 / Risk 1).
           // allow_directory takes (path, recursive).
           app.fs_scope()
               .allow_directory(&canonical, true)
               .map_err(|e| VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;

           // Persist as the active vault
           {
               let mut guard = state.current_vault.lock().unwrap();
               *guard = Some(canonical.clone());
           }

           // Push to recent-vaults.json
           let canonical_str = canonical.to_string_lossy().into_owned();
           push_recent_vault(&app, &canonical_str)?;

           let file_count = count_md_files(&canonical);
           Ok(VaultInfo {
               path: canonical_str,
               file_count,
           })
       }

       fn recent_vaults_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
           let dir = app
               .path()
               .app_data_dir()
               .map_err(|e| VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
           std::fs::create_dir_all(&dir).map_err(VaultError::Io)?;
           Ok(dir.join(RECENT_VAULTS_FILENAME))
       }

       fn read_recent_vaults_at(file: &Path) -> Result<Vec<RecentVault>, VaultError> {
           if !file.exists() {
               return Ok(Vec::new());
           }
           let raw = std::fs::read_to_string(file).map_err(VaultError::Io)?;
           let data: RecentVaultsFile = serde_json::from_str(&raw).unwrap_or_default();
           Ok(data.vaults)
       }

       fn write_recent_vaults_at(file: &Path, vaults: &[RecentVault]) -> Result<(), VaultError> {
           let data = RecentVaultsFile { vaults: vaults.to_vec() };
           let json = serde_json::to_string_pretty(&data)
               .map_err(|e| VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
           std::fs::write(file, json).map_err(VaultError::Io)
       }

       pub fn push_recent_vault_to(
           file: &Path,
           path: &str,
           now_iso: String,
       ) -> Result<Vec<RecentVault>, VaultError> {
           let mut vaults = read_recent_vaults_at(file)?;
           vaults.retain(|v| v.path != path);
           vaults.insert(
               0,
               RecentVault {
                   path: path.to_string(),
                   last_opened: now_iso,
               },
           );
           if vaults.len() > MAX_RECENT {
               vaults.truncate(MAX_RECENT);
           }
           write_recent_vaults_at(file, &vaults)?;
           Ok(vaults)
       }

       fn push_recent_vault(app: &AppHandle, path: &str) -> Result<Vec<RecentVault>, VaultError> {
           let file = recent_vaults_path(app)?;
           let now = chrono_like_iso();
           push_recent_vault_to(&file, path, now)
       }

       /// RFC 3339 / ISO-8601 UTC timestamp without pulling in `chrono` (D-19 forbids it)
       /// and without adding a `time` crate dep (not in the D-19 Phase 1 allow-list).
       /// Format: `YYYY-MM-DDTHH:MM:SSZ` (e.g., `2026-04-11T14:23:07Z`).
       /// Uses Howard Hinnant's public-domain civil-from-days algorithm.
       /// Valid for years 1970..9999; ignores leap seconds (std can't see them).
       fn chrono_like_iso() -> String {
           use std::time::{SystemTime, UNIX_EPOCH};
           let secs = SystemTime::now()
               .duration_since(UNIX_EPOCH)
               .map(|d| d.as_secs() as i64)
               .unwrap_or(0);
           format_iso8601_utc(secs)
       }

       /// Epoch-seconds → `YYYY-MM-DDTHH:MM:SSZ`. Pure std, no deps.
       /// Based on Howard Hinnant's `civil_from_days` (http://howardhinnant.github.io/date_algorithms.html).
       pub(crate) fn format_iso8601_utc(epoch_secs: i64) -> String {
           let days = epoch_secs.div_euclid(86_400);
           let tod = epoch_secs.rem_euclid(86_400);
           let h = tod / 3600;
           let m = (tod % 3600) / 60;
           let s = tod % 60;

           // Shift epoch day 0 (1970-01-01) to era-based origin (0000-03-01).
           let z = days + 719_468;
           let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
           let doe = (z - era * 146_097) as i64; // [0, 146096]
           let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
           let y = yoe + era * 400;
           let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
           let mp = (5 * doy + 2) / 153; // [0, 11]
           let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
           let mo = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
           let year = if mo <= 2 { y + 1 } else { y };

           format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, mo, d, h, m, s)
       }

       #[tauri::command]
       pub async fn get_recent_vaults(app: AppHandle) -> Result<Vec<RecentVault>, VaultError> {
           let file = recent_vaults_path(&app)?;
           read_recent_vaults_at(&file)
       }
       ```

    4. **Fill in `src-tauri/src/tests/vault_stats.rs`** (remove all `#[ignore]`, use `tempfile` — but D-19 does NOT include tempfile, so use `std::env::temp_dir` + `std::fs` cleanup):

       First, add `tempfile = "3"` under `[dev-dependencies]` in Cargo.toml (dev-dependencies are NOT subject to the D-19 runtime dep constraint; they're test-only):

       ```toml
       [dev-dependencies]
       tempfile = "3"
       ```

       Then:
       ```rust
       use crate::commands::vault::{count_md_files, push_recent_vault_to, RecentVault};
       use std::fs;
       use tempfile::tempdir;

       #[test]
       fn get_vault_stats_counts_md_files() {
           let dir = tempdir().unwrap();
           fs::write(dir.path().join("a.md"), "").unwrap();
           fs::write(dir.path().join("b.md"), "").unwrap();
           fs::write(dir.path().join("c.txt"), "").unwrap(); // ignored
           fs::create_dir(dir.path().join("sub")).unwrap();
           fs::write(dir.path().join("sub/d.md"), "").unwrap();
           assert_eq!(count_md_files(dir.path()), 3);
       }

       #[test]
       fn get_vault_stats_skips_dot_dirs() {
           let dir = tempdir().unwrap();
           fs::write(dir.path().join("a.md"), "").unwrap();
           fs::create_dir(dir.path().join(".obsidian")).unwrap();
           fs::write(dir.path().join(".obsidian/workspace.md"), "").unwrap();
           fs::create_dir(dir.path().join(".git")).unwrap();
           fs::write(dir.path().join(".git/config.md"), "").unwrap();
           assert_eq!(count_md_files(dir.path()), 1);
       }

       #[test]
       fn recent_vaults_round_trip() {
           let dir = tempdir().unwrap();
           let file = dir.path().join("recent-vaults.json");
           let vaults = push_recent_vault_to(&file, "/a", "100Z".into()).unwrap();
           assert_eq!(vaults.len(), 1);
           assert_eq!(vaults[0].path, "/a");
           // Read-back via a fresh push
           let vaults = push_recent_vault_to(&file, "/b", "200Z".into()).unwrap();
           assert_eq!(vaults.len(), 2);
           assert_eq!(vaults[0].path, "/b"); // newest first
           assert_eq!(vaults[1].path, "/a");
       }

       #[test]
       fn recent_vaults_eviction_caps_at_ten() {
           let dir = tempdir().unwrap();
           let file = dir.path().join("recent-vaults.json");
           for i in 0..15 {
               push_recent_vault_to(&file, &format!("/p{}", i), format!("{}Z", i)).unwrap();
           }
           let vaults = push_recent_vault_to(&file, "/final", "999Z".into()).unwrap();
           assert_eq!(vaults.len(), 10);
           assert_eq!(vaults[0].path, "/final");
           // The oldest entries (/p0../p5) should be evicted
           assert!(!vaults.iter().any(|v| v.path == "/p0"));
           assert!(!vaults.iter().any(|v| v.path == "/p5"));
       }

       #[test]
       fn recent_vaults_dedupe_moves_to_front() {
           let dir = tempdir().unwrap();
           let file = dir.path().join("recent-vaults.json");
           push_recent_vault_to(&file, "/a", "1Z".into()).unwrap();
           push_recent_vault_to(&file, "/b", "2Z".into()).unwrap();
           let vaults = push_recent_vault_to(&file, "/a", "3Z".into()).unwrap();
           assert_eq!(vaults.len(), 2);
           assert_eq!(vaults[0].path, "/a"); // re-added at front
           assert_eq!(vaults[1].path, "/b");
       }

       #[test]
       fn open_vault_returns_vault_unavailable_for_missing_path() {
           // get_vault_stats mirrors the open_vault unreachable branch for this test.
           let result = tokio_test_block_on(crate::commands::vault::get_vault_stats(
               "/definitely/does/not/exist/vaultcore-test".to_string(),
           ));
           match result {
               Err(crate::error::VaultError::VaultUnavailable { path }) => {
                   assert!(path.contains("definitely"));
               }
               other => panic!("expected VaultUnavailable, got {:?}", other),
           }
       }

       fn tokio_test_block_on<F: std::future::Future>(f: F) -> F::Output {
           tokio::runtime::Builder::new_current_thread()
               .enable_all()
               .build()
               .unwrap()
               .block_on(f)
       }
       ```

    Note on `chrono_like_iso`: D-19 forbids `chrono` and doesn't allow the `time` crate either. We hand-roll ISO-8601 via Howard Hinnant's civil-from-days algorithm (~15 lines, pure std, zero deps). Output matches D-23's `last_opened: "ISO-8601"` schema literally — `YYYY-MM-DDTHH:MM:SSZ` — so the strings are both sort-correct AND human-readable in `recent-vaults.json`.

    Also add this test to `src-tauri/src/tests/vault_stats.rs` to pin the format:

    ```rust
    #[test]
    fn format_iso8601_utc_matches_rfc3339() {
        use crate::commands::vault::format_iso8601_utc;
        // 2026-04-11T00:00:00Z → epoch 1775606400
        assert_eq!(format_iso8601_utc(1_775_606_400), "2026-04-11T00:00:00Z");
        // Unix epoch itself
        assert_eq!(format_iso8601_utc(0), "1970-01-01T00:00:00Z");
        // 2000-02-29T12:34:56Z → leap day sanity (epoch 951_827_696)
        assert_eq!(format_iso8601_utc(951_827_696), "2000-02-29T12:34:56Z");
    }
    ```
  </action>
  <verify>
    <automated>cd src-tauri &amp;&amp; cargo test recent_vaults &amp;&amp; cargo test get_vault_stats &amp;&amp; cargo test open_vault_returns &amp;&amp; cargo test hash_ &amp;&amp; cargo build</automated>
  </verify>
  <acceptance_criteria>
    - `src-tauri/src/hash.rs` contains `pub fn hash_bytes` AND `Sha256::digest`
    - `src-tauri/src/commands/vault.rs` contains `pub struct VaultInfo`, `pub struct VaultStats`, `pub struct RecentVault`, `pub async fn open_vault`, `pub async fn get_recent_vaults`, `pub async fn get_vault_stats`, `pub fn count_md_files`, `pub fn push_recent_vault_to`
    - `grep -c "allow_directory" src-tauri/src/commands/vault.rs` returns at least 1
    - `grep -c "canonicalize" src-tauri/src/commands/vault.rs` returns at least 1
    - `grep -c "MAX_RECENT: usize = 10" src-tauri/src/commands/vault.rs` returns 1
    - `src-tauri/src/lib.rs` contains `pub struct VaultState` AND `.manage(VaultState::default())` AND `generate_handler!` with all five commands
    - `src-tauri/Cargo.toml` contains `tempfile` under `[dev-dependencies]`
    - `src-tauri/src/tests/vault_stats.rs` does NOT contain `#[ignore]`
    - `cargo test --manifest-path src-tauri/Cargo.toml recent_vaults_eviction_caps_at_ten` exits 0 with 1 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml get_vault_stats_counts_md_files` exits 0 with 1 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml get_vault_stats_skips_dot_dirs` exits 0 with 1 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml recent_vaults_dedupe_moves_to_front` exits 0 with 1 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml open_vault_returns_vault_unavailable_for_missing_path` exits 0
    - `cargo test --manifest-path src-tauri/Cargo.toml format_iso8601_utc_matches_rfc3339` exits 0 with 1 passed
    - `grep -c "fn format_iso8601_utc" src-tauri/src/commands/vault.rs` returns 1
    - `grep -E '"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"' src-tauri/src/tests/vault_stats.rs` returns at least one match
    - `cargo build --manifest-path src-tauri/Cargo.toml` exits 0
    - NO reference to `chrono` in `Cargo.toml`
    - NO reference to `time = ` in `src-tauri/Cargo.toml` runtime deps (D-19 allow-list only)
  </acceptance_criteria>
  <done>vault.rs commands compile, recent-vaults JSON round-trips with FIFO-10 eviction + dedupe, walkdir counter skips dot-dirs, fs_scope runtime expansion wired into open_vault.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: files.rs with UTF-8 guard + vault-scope guard + SHA-256 write</name>
  <files>src-tauri/src/commands/files.rs, src-tauri/src/tests/mod.rs, src-tauri/src/tests/files.rs</files>
  <read_first>
    - .planning/phases/01-skeleton/01-RESEARCH.md §4.2 Non-UTF-8 detection, §4.3 SHA-256 pattern
    - .planning/phases/01-skeleton/01-CONTEXT.md D-17 (read_file returns InvalidEncoding)
    - src-tauri/src/commands/files.rs (Wave 0 placeholder)
    - src-tauri/src/lib.rs (VaultState was added in Task 2)
    - src-tauri/src/hash.rs (from Task 2)
  </read_first>
  <behavior>
    - `read_file("/tmp/vault/a.md")` where vault is `/tmp/vault` → returns the file contents as String
    - `read_file("/tmp/vault/binary.bin")` where binary.bin contains bytes `[0xff, 0xfe, 0x00]` → returns `VaultError::InvalidEncoding { path: "/tmp/vault/binary.bin" }`
    - `read_file("/etc/passwd")` when vault is `/tmp/vault` → returns `VaultError::PermissionDenied` (or similar refusal — MUST NOT return the file contents, T-02)
    - `write_file("/tmp/vault/a.md", "hello")` → writes bytes, returns SHA-256 hex of the written content
    - `write_file("/etc/shadow", ...)` → returns `VaultError::PermissionDenied`
    - Missing file: `VaultError::FileNotFound`
  </behavior>
  <action>
    1. **Write `src-tauri/src/commands/files.rs`:**
       ```rust
       use crate::error::VaultError;
       use crate::hash::hash_bytes;
       use crate::VaultState;
       use std::path::{Path, PathBuf};

       /// T-02 mitigation: reject paths that resolve outside the currently-open vault.
       fn ensure_inside_vault(state: &VaultState, target: &Path) -> Result<PathBuf, VaultError> {
           let guard = state.current_vault.lock().unwrap();
           let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
               path: target.display().to_string(),
           })?;
           let canonical_target = std::fs::canonicalize(target).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::FileNotFound {
                   path: target.display().to_string(),
               },
               std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
                   path: target.display().to_string(),
               },
               _ => VaultError::Io(e),
           })?;
           if !canonical_target.starts_with(vault) {
               return Err(VaultError::PermissionDenied {
                   path: canonical_target.display().to_string(),
               });
           }
           Ok(canonical_target)
       }

       #[tauri::command]
       pub async fn read_file(
           state: tauri::State<'_, VaultState>,
           path: String,
       ) -> Result<String, VaultError> {
           let target = PathBuf::from(&path);
           let canonical = ensure_inside_vault(&state, &target)?;
           let bytes = std::fs::read(&canonical).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
               std::io::ErrorKind::PermissionDenied => {
                   VaultError::PermissionDenied { path: path.clone() }
               }
               _ => VaultError::Io(e),
           })?;
           String::from_utf8(bytes).map_err(|_| VaultError::InvalidEncoding { path })
       }

       #[tauri::command]
       pub async fn write_file(
           state: tauri::State<'_, VaultState>,
           path: String,
           content: String,
       ) -> Result<String, VaultError> {
           let target = PathBuf::from(&path);

           // For writes, we must canonicalize the *parent* (the file may not exist yet)
           // and then ensure parent is inside the vault.
           let parent = target
               .parent()
               .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
           let canonical_parent = std::fs::canonicalize(parent).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
               std::io::ErrorKind::PermissionDenied => {
                   VaultError::PermissionDenied { path: path.clone() }
               }
               _ => VaultError::Io(e),
           })?;
           {
               let guard = state.current_vault.lock().unwrap();
               let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
                   path: path.clone(),
               })?;
               if !canonical_parent.starts_with(vault) {
                   return Err(VaultError::PermissionDenied { path: path.clone() });
               }
           }

           let file_name = target
               .file_name()
               .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
           let final_path = canonical_parent.join(file_name);

           let bytes = content.as_bytes();
           std::fs::write(&final_path, bytes).map_err(|e| match e.kind() {
               std::io::ErrorKind::PermissionDenied => {
                   VaultError::PermissionDenied { path: path.clone() }
               }
               std::io::ErrorKind::StorageFull => VaultError::DiskFull,
               _ => VaultError::Io(e),
           })?;
           Ok(hash_bytes(bytes))
       }
       ```

    2. **Register the files test module** — update `src-tauri/src/tests/mod.rs`:
       ```rust
       mod error_serialize;
       mod vault_stats;
       mod files;
       ```

    3. **Create `src-tauri/src/tests/files.rs`:**
       ```rust
       use crate::commands::files::{read_file, write_file};
       use crate::error::VaultError;
       use crate::VaultState;
       use std::fs;
       use std::path::PathBuf;
       use tempfile::tempdir;

       fn tokio_test_block_on<F: std::future::Future>(f: F) -> F::Output {
           tokio::runtime::Builder::new_current_thread()
               .enable_all()
               .build()
               .unwrap()
               .block_on(f)
       }

       fn state_with_vault(root: &std::path::Path) -> VaultState {
           let canonical = fs::canonicalize(root).unwrap();
           let s = VaultState::default();
           *s.current_vault.lock().unwrap() = Some(canonical);
           s
       }

       // For unit testing we bypass tauri::State by calling the inner logic directly.
       // The tauri::command attribute is a thin wrapper — we invoke the async fn body via a
       // helper that builds the same State<'_, VaultState>.
       //
       // Because tauri::State can't be constructed outside a full Tauri app in unit tests,
       // we refactor the command bodies into a non-command `fn *_impl` that takes
       // &VaultState directly, and the tauri::command shim forwards to it. Tests call `_impl`.

       #[test]
       fn read_file_returns_utf8_content() {
           let dir = tempdir().unwrap();
           let path = dir.path().join("hello.md");
           fs::write(&path, "# Hello").unwrap();
           let state = state_with_vault(dir.path());
           let result = tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into()));
           assert_eq!(result.unwrap(), "# Hello");
       }

       #[test]
       fn read_file_rejects_non_utf8_as_invalid_encoding() {
           let dir = tempdir().unwrap();
           let path = dir.path().join("bin.md");
           fs::write(&path, [0xff, 0xfe, 0x00, 0x01]).unwrap();
           let state = state_with_vault(dir.path());
           let result = tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into()));
           match result {
               Err(VaultError::InvalidEncoding { path: p }) => assert!(p.contains("bin.md")),
               other => panic!("expected InvalidEncoding, got {:?}", other),
           }
       }

       #[test]
       fn read_file_rejects_path_outside_vault() {
           let vault_dir = tempdir().unwrap();
           let outside_dir = tempdir().unwrap();
           let outside_path = outside_dir.path().join("secret.md");
           fs::write(&outside_path, "secret").unwrap();
           let state = state_with_vault(vault_dir.path());
           let result = tokio_test_block_on(read_file_impl(
               &state,
               outside_path.to_string_lossy().into(),
           ));
           match result {
               Err(VaultError::PermissionDenied { .. }) => {}
               other => panic!("expected PermissionDenied, got {:?}", other),
           }
       }

       #[test]
       fn write_file_writes_bytes_and_returns_hash() {
           let dir = tempdir().unwrap();
           let path = dir.path().join("note.md");
           let state = state_with_vault(dir.path());
           let hash = tokio_test_block_on(write_file_impl(
               &state,
               path.to_string_lossy().into(),
               "hello".into(),
           ))
           .unwrap();
           assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
           // Known SHA-256 of "hello"
           assert_eq!(
               hash,
               "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
           );
       }

       #[test]
       fn write_file_rejects_path_outside_vault() {
           let vault_dir = tempdir().unwrap();
           let outside_dir = tempdir().unwrap();
           let state = state_with_vault(vault_dir.path());
           let result = tokio_test_block_on(write_file_impl(
               &state,
               outside_dir.path().join("evil.md").to_string_lossy().into(),
               "pwn".into(),
           ));
           match result {
               Err(VaultError::PermissionDenied { .. }) => {}
               other => panic!("expected PermissionDenied, got {:?}", other),
           }
       }

       // --- _impl helpers that mirror the tauri::command bodies without State<'_, ...> ---

       async fn read_file_impl(state: &VaultState, path: String) -> Result<String, VaultError> {
           use std::path::PathBuf;
           let target = PathBuf::from(&path);
           let canonical_target = std::fs::canonicalize(&target).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
               std::io::ErrorKind::PermissionDenied => {
                   VaultError::PermissionDenied { path: path.clone() }
               }
               _ => VaultError::Io(e),
           })?;
           {
               let guard = state.current_vault.lock().unwrap();
               let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
                   path: path.clone(),
               })?;
               if !canonical_target.starts_with(vault) {
                   return Err(VaultError::PermissionDenied { path });
               }
           }
           let bytes = std::fs::read(&canonical_target).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
               _ => VaultError::Io(e),
           })?;
           String::from_utf8(bytes).map_err(|_| VaultError::InvalidEncoding { path })
       }

       async fn write_file_impl(
           state: &VaultState,
           path: String,
           content: String,
       ) -> Result<String, VaultError> {
           use std::path::PathBuf;
           let target = PathBuf::from(&path);
           let parent = target
               .parent()
               .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
           let canonical_parent = std::fs::canonicalize(parent).map_err(|e| match e.kind() {
               std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
               std::io::ErrorKind::PermissionDenied => {
                   VaultError::PermissionDenied { path: path.clone() }
               }
               _ => VaultError::Io(e),
           })?;
           {
               let guard = state.current_vault.lock().unwrap();
               let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
                   path: path.clone(),
               })?;
               if !canonical_parent.starts_with(vault) {
                   return Err(VaultError::PermissionDenied { path });
               }
           }
           let file_name = target
               .file_name()
               .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
           let final_path = canonical_parent.join(file_name);
           let bytes = content.as_bytes();
           std::fs::write(&final_path, bytes).map_err(|e| match e.kind() {
               std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path },
               std::io::ErrorKind::StorageFull => VaultError::DiskFull,
               _ => VaultError::Io(e),
           })?;
           Ok(crate::hash::hash_bytes(bytes))
       }
       ```

    Note on `_impl` duplication: we duplicate the logic instead of refactoring because `tauri::State` cannot be constructed in unit tests without a full Tauri app. The `tauri::command` fn in `files.rs` and the `_impl` helper here must stay byte-identical in logic — if you change one, change both. A future refactor can extract to a shared module.
  </action>
  <verify>
    <automated>cd src-tauri &amp;&amp; cargo test read_file &amp;&amp; cargo test write_file &amp;&amp; cargo build</automated>
  </verify>
  <acceptance_criteria>
    - `src-tauri/src/commands/files.rs` contains `pub async fn read_file` AND `pub async fn write_file` AND `fn ensure_inside_vault`
    - `grep -c "InvalidEncoding" src-tauri/src/commands/files.rs` returns at least 1
    - `grep -c "starts_with(vault)" src-tauri/src/commands/files.rs` returns at least 1 (T-02 vault-scope guard)
    - `grep -c "String::from_utf8" src-tauri/src/commands/files.rs` returns at least 1
    - `grep -c "hash_bytes" src-tauri/src/commands/files.rs` returns at least 1
    - `src-tauri/src/tests/mod.rs` contains `mod files;`
    - `src-tauri/src/tests/files.rs` contains tests: `fn read_file_returns_utf8_content`, `fn read_file_rejects_non_utf8_as_invalid_encoding`, `fn read_file_rejects_path_outside_vault`, `fn write_file_writes_bytes_and_returns_hash`, `fn write_file_rejects_path_outside_vault`
    - `cargo test --manifest-path src-tauri/Cargo.toml read_file_rejects_non_utf8_as_invalid_encoding` exits 0 with 1 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml read_file_rejects_path_outside_vault` exits 0 with 1 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml write_file_writes_bytes_and_returns_hash` exits 0 with 1 passed
    - `cargo test --manifest-path src-tauri/Cargo.toml write_file_rejects_path_outside_vault` exits 0 with 1 passed
    - `cargo build --manifest-path src-tauri/Cargo.toml` exits 0
    - `cargo test --manifest-path src-tauri/Cargo.toml` overall exits 0
  </acceptance_criteria>
  <done>files.rs commands implement UTF-8 enforcement at the read boundary, vault-scope guards for T-02, SHA-256 hash return from write_file, and all five cargo unit tests pass.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| frontend → Rust command | User-controlled `path: String` arguments cross from JS into Rust |
| Rust command → filesystem | Rust reads/writes real files on disk |
| Rust command → app data dir | `recent-vaults.json` is written by the app from user-controlled path strings |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01 | Tampering (path traversal) | `open_vault` | mitigate | Task 2: `open_vault` calls `std::fs::canonicalize` before any further use, resolving `..` and symlinks. Canonical path is stored in `VaultState` and is the ONLY acceptable prefix for later file operations. |
| T-02 | Information Disclosure (arbitrary read/write) | `read_file`, `write_file` | mitigate | Task 3: both commands canonicalize the target path (or target's parent, for write) and assert `canonical_target.starts_with(vault)` before touching the filesystem. A test (`read_file_rejects_path_outside_vault`) asserts that `/etc/passwd`-style paths return `PermissionDenied` even when the frontend requests them. |
| T-03 | Tampering (binary corruption via auto-save) | `read_file` → editor → `write_file` loop | mitigate | Task 3: `read_file` refuses non-UTF-8 bytes with `VaultError::InvalidEncoding` (D-17). A non-UTF-8 file is therefore NEVER loaded into the editor, so auto-save cannot truncate/corrupt it. Test `read_file_rejects_non_utf8_as_invalid_encoding` enforces this. |
| T-04 | Tampering (JSON injection) | `recent-vaults.json` writer | mitigate | Task 2: `push_recent_vault_to` uses `serde_json::to_string_pretty` to serialize — no string concatenation. Malicious paths with `"`, `\`, or newlines are escaped by serde_json. `recent_vaults_round_trip` test confirms byte-accurate round-trip. |
| T-05 | Spoofing (event channel) | `vault://index_progress` | accept | Phase 1 does not yet emit this event (Plan 01-04 does). Desktop process isolation means only the VaultCore backend can emit on this channel; accepted risk for v0.1. Will re-evaluate in Phase 3 when real indexer lands. |
| T-06 | Information Disclosure (zero-network guarantee) | Rust crate set | mitigate | Task 1/2/3: D-19 crate set contains NO networking crate. `Cargo.toml` grep check in acceptance criteria confirms no `reqwest`, `hyper`, `ureq`, `surf`, `curl`. `thiserror + serde + walkdir + sha2 + tokio` — none are network clients. |
| T-01-01-S | Spoofing (tauri::State misuse) | `VaultState` | mitigate | Wave 1 introduces `VaultState` with `Mutex<Option<PathBuf>>` — any command that wants to touch files must acquire the lock and read the canonical vault. This is the single source of truth. No global `static` paths. |
| T-01-01-E | Elevation (FsExt runtime scope bypass) | `open_vault` | mitigate | Task 2: `app.fs_scope().allow_directory(&canonical, true)` grants the plugin-fs scope at runtime only to the canonicalized vault path (Risk 1 in RESEARCH). Static scope in capabilities/default.json remains limited to `$APPDATA` only. |
</threat_model>

<verification>
- `cargo build --manifest-path src-tauri/Cargo.toml` exits 0
- `cargo test --manifest-path src-tauri/Cargo.toml` overall exits 0 with all Wave 0 stubs now executing
- `grep -rE "(reqwest|hyper|ureq|surf|curl)" src-tauri/Cargo.toml` returns nothing (zero-network verification)
- `grep -rE "http://|https://" src-tauri/src/` returns nothing
</verification>

<success_criteria>
1. All 8 ERR-01 serde tests pass (`cargo test vault_error_serialize` → 8 passed)
2. VAULT-02/04/06 tests pass (round-trip, eviction, dedupe, counter, unavailable fallback)
3. files.rs unit tests pass (UTF-8 reject, outside-vault reject for read + write, hash return)
4. `cargo build` green on the full workspace
5. Every command from the `<interfaces>` block is exported and listed in `generate_handler!`
6. No HTTP/networking crates in Cargo.toml (SEC-01 compliance)
</success_criteria>

<output>
After completion, create `.planning/phases/01-skeleton/01-01-SUMMARY.md` per summary template.
</output>
