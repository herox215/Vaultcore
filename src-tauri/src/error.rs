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

    #[error("Search index is locked by another process")]
    IndexLocked,

    #[error("Vault unavailable: {path}")]
    VaultUnavailable { path: String },

    #[error("Merge conflict: {path}")]
    MergeConflict { path: String },

    #[error("File is not UTF-8: {path}")]
    InvalidEncoding { path: String },

    /// A `Mutex`/`RwLock` was poisoned because a previous panic unwound
    /// while holding the guard. Never user-caused — always a programming
    /// error. Kept data-less because the cause is always the same and the
    /// only useful user action is "restart the app, then report the bug".
    #[error("Internal state lock poisoned — please restart VaultCore")]
    LockPoisoned,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    // #345: encrypted-folder errors.
    /// Path lies inside a currently-locked encrypted folder. Every
    /// read/write/rename/delete path gates on this before touching disk.
    #[error("Path is inside a locked encrypted folder: {path}")]
    PathLocked { path: String },

    /// Returned by `unlock_folder` and by any decrypt that fails its
    /// Poly1305 tag — the frontend maps this to a modal error row, not a
    /// toast, so wrong-password typos stay attached to the prompt.
    #[error("Wrong password")]
    WrongPassword,

    /// Any other crypto-layer failure (truncated container, wrong magic,
    /// KDF internal error). Distinct from `WrongPassword` so UX can
    /// surface "this file looks corrupted" vs "your password was wrong".
    #[error("Encryption error: {msg}")]
    CryptoError { msg: String },

    /// #357: file size exceeds the inline-encryption cap for auto-encrypt
    /// on drop into an encrypted folder. Surfaced so the frontend toast
    /// can tell the user to move the file out or encrypt manually.
    /// Streaming encryption (VCE2 follow-up) will raise or remove the cap.
    #[error(
        "File too large to auto-encrypt ({size} bytes, cap {cap}): {path}. \
         Move it outside the encrypted folder or use manual encryption."
    )]
    PayloadTooLarge { path: String, size: u64, cap: u64 },

    /// #391: native picker (NSOpenPanel / GTK file chooser /
    /// ACTION_OPEN_DOCUMENT_TREE) failed in a way that is not user
    /// cancellation. Cancellation is signalled via `Ok(None)` from the
    /// picker commands; this variant carries genuine errors only —
    /// channel closed, mobile-plugin-bridge deserialize failure, etc.
    #[error("Picker failed: {msg}")]
    PickerFailed { msg: String },
}

impl VaultError {
    pub fn variant_name(&self) -> &'static str {
        match self {
            Self::FileNotFound { .. } => "FileNotFound",
            Self::PermissionDenied { .. } => "PermissionDenied",
            Self::DiskFull => "DiskFull",
            Self::IndexCorrupt => "IndexCorrupt",
            Self::IndexLocked => "IndexLocked",
            Self::VaultUnavailable { .. } => "VaultUnavailable",
            Self::MergeConflict { .. } => "MergeConflict",
            Self::InvalidEncoding { .. } => "InvalidEncoding",
            Self::LockPoisoned => "LockPoisoned",
            Self::Io(_) => "Io",
            Self::PathLocked { .. } => "PathLocked",
            Self::WrongPassword => "WrongPassword",
            Self::CryptoError { .. } => "CryptoError",
            Self::PayloadTooLarge { .. } => "PayloadTooLarge",
            Self::PickerFailed { .. } => "PickerFailed",
        }
    }

    pub fn extra_data(&self) -> Option<String> {
        match self {
            Self::FileNotFound { path }
            | Self::PermissionDenied { path }
            | Self::VaultUnavailable { path }
            | Self::MergeConflict { path }
            | Self::InvalidEncoding { path }
            | Self::PathLocked { path }
            | Self::PayloadTooLarge { path, .. } => Some(path.clone()),
            // `extra_data` is the IPC `data` field, reserved for a path
            // so frontend callers can `navigate(err.data)`. CryptoError /
            // PickerFailed carry a human message, not a path — surfacing
            // it here would break that contract. The message still ships
            // via `Display` (the IPC `message` field); nothing is lost.
            Self::CryptoError { .. }
            | Self::WrongPassword
            | Self::PickerFailed { .. } => None,
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
