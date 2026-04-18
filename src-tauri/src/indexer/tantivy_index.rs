// Tantivy schema, index management, and helper functions.
//
// T-03-03 (accept): index_version.json can be manually edited by the user;
// worst case is an unnecessary rebuild — no security impact since the index is
// a rebuildable cache.

use std::path::Path;
use tantivy::schema::{Field, Schema, STORED, STRING, TEXT};
use tantivy::{Index, TantivyError};

use crate::error::VaultError;

/// Schema version bumped whenever the Tantivy schema changes in a way that
/// requires a full rebuild.  Stored in `.vaultcore/index_version.json`.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Build the Tantivy schema and return the schema plus the three core fields.
///
/// Fields:
/// - `path`: STRING | STORED — exact match and delete key
/// - `title`: TEXT | STORED — tokenised title for search
/// - `body`: TEXT | STORED — tokenised body; stored for SnippetGenerator
pub fn build_schema() -> (Schema, Field, Field, Field) {
    let mut builder = Schema::builder();
    let path_field = builder.add_text_field("path", STRING | STORED);
    let title_field = builder.add_text_field("title", TEXT | STORED);
    let body_field = builder.add_text_field("body", TEXT | STORED);
    let schema = builder.build();
    (schema, path_field, title_field, body_field)
}

/// Open an existing Tantivy index in `index_dir`, or create one if the
/// directory is empty or does not yet contain a valid index.
///
/// Maps `TantivyError` to `VaultError::IndexCorrupt` so the caller can
/// trigger an automatic rebuild (ERR-02).
pub fn open_or_create_index(index_dir: &Path, schema: &Schema) -> Result<Index, VaultError> {
    if index_dir.exists() {
        // Try to open the existing index.
        match Index::open_in_dir(index_dir) {
            Ok(idx) => return Ok(idx),
            Err(TantivyError::SchemaError(_)) | Err(TantivyError::OpenDirectoryError(_)) => {
                // Fall through to create a fresh index below.
            }
            Err(_e) => {
                return Err(VaultError::IndexCorrupt);
            }
        }
    }

    // Create the directory if it doesn't exist and create a fresh index.
    std::fs::create_dir_all(index_dir).map_err(VaultError::Io)?;
    Index::create_in_dir(index_dir, schema.clone()).map_err(|_| VaultError::IndexCorrupt)
}

/// Returns `true` if `.vaultcore/index_version.json` exists and its
/// `schema_version` field equals `CURRENT_SCHEMA_VERSION`.
pub fn check_version(vaultcore_dir: &Path) -> bool {
    let version_file = vaultcore_dir.join("index_version.json");
    if !version_file.exists() {
        return false;
    }
    let raw = match std::fs::read_to_string(&version_file) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return false,
    };
    value
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .map(|v| v == CURRENT_SCHEMA_VERSION as u64)
        .unwrap_or(false)
}

/// Write `.vaultcore/index_version.json` with the current schema version.
pub fn write_version(vaultcore_dir: &Path) -> Result<(), VaultError> {
    use std::time::{SystemTime, UNIX_EPOCH};

    std::fs::create_dir_all(vaultcore_dir).map_err(VaultError::Io)?;

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let created_at = iso8601_utc(secs);

    let json = serde_json::json!({
        "schema_version": CURRENT_SCHEMA_VERSION,
        "app_version": "0.1.0",
        "created_at": created_at,
    });
    let content = serde_json::to_string_pretty(&json).map_err(|e| {
        VaultError::Io(std::io::Error::other(e.to_string()))
    })?;

    let version_file = vaultcore_dir.join("index_version.json");
    std::fs::write(version_file, content).map_err(VaultError::Io)
}

/// Minimal ISO-8601 UTC timestamp (std-only, no chrono dep).
fn iso8601_utc(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let tod = epoch_secs.rem_euclid(86_400);
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    let s = tod % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if mo <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, mo, d, h, m, s)
}

/// Extract the first `# ` heading from Markdown content, or fall back to
/// `filename_stem`.
pub fn extract_title(md_content: &str, filename_stem: &str) -> String {
    for line in md_content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    filename_stem.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn extract_title_finds_h1() {
        assert_eq!(extract_title("# My Title\nBody", "fallback"), "My Title");
    }

    #[test]
    fn extract_title_falls_back_to_stem() {
        assert_eq!(extract_title("No heading here", "fallback"), "fallback");
    }

    #[test]
    fn extract_title_empty_content() {
        assert_eq!(extract_title("", "stem"), "stem");
    }

    #[test]
    fn check_version_returns_false_for_missing_file() {
        let dir = TempDir::new().unwrap();
        assert!(!check_version(dir.path()));
    }

    #[test]
    fn write_then_check_version_returns_true() {
        let dir = TempDir::new().unwrap();
        write_version(dir.path()).unwrap();
        assert!(check_version(dir.path()));
    }

    #[test]
    fn build_schema_returns_three_fields() {
        let (schema, path_field, title_field, body_field) = build_schema();
        assert!(schema.get_field_entry(path_field).name() == "path");
        assert!(schema.get_field_entry(title_field).name() == "title");
        assert!(schema.get_field_entry(body_field).name() == "body");
    }
}
