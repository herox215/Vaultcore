// Full VaultError enum per spec §5 — one variant per error case the frontend
// must distinguish. Serializes as `{ kind, message, data }` for IPC.
//
// This replaces the Wave 0 `Placeholder` variant with the full shape.
// The serde::Serialize impl is manual because thiserror's #[error] Display
// is used as the `message` field and `data` carries the variant-specific
// payload path (or null for data-less variants).

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
