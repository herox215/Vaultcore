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

    /// #392: relative path resolved outside the vault root. Distinct
    /// from `PermissionDenied` (which is OS-level access refusal) — this
    /// is a T-02 violation, either client bug or attack: the resolved
    /// canonical path was outside `vault_root`. Never user-actionable; UI
    /// renders a generic "request denied" copy and logs for follow-up.
    #[error("Path resolves outside the vault: {path}")]
    PathOutsideVault { path: String },

    /// #392 PR-B: SAF tree URI no longer has a persisted permission grant
    /// — user revoked it via Settings, or the app was reinstalled. The
    /// frontend re-pick UX consumes the `uri` from `data` so the user
    /// can re-grant access without retyping anything.
    #[error("Vault permission revoked: {uri}")]
    VaultPermissionRevoked { uri: String },

    /// #392 PR-B: encrypted-folder operation requested while the vault
    /// is `content://`-rooted on Android. The encryption manifest is
    /// canonical-path-keyed (encryption/mod.rs:185) and doesn't yet have
    /// a URI-aware variant; runtime guard fails fast at every
    /// create/unlock/lock entry. Tracked: #345 storage-trait pass.
    #[error("Encrypted folders are not yet supported on Android.")]
    EncryptionUnsupportedOnAndroid,

    /// #392 PR-B: a desktop-only operation (HTML export, snippet/template
    /// walks, fulltext rebuild, etc.) was requested while the active
    /// vault is `content://`-rooted on Android. Distinct from
    /// `EncryptionUnsupportedOnAndroid` so the frontend can render an
    /// operation-specific copy ("HTML export isn't supported on Android
    /// yet") rather than a generic encryption-themed message. The
    /// `operation` field carries the human-readable name; it lands in
    /// the `data` field as a label, not a navigable target. Aristotle
    /// iter-1 finding #4 — replaces the previous shoehorn that put
    /// prose into a `PermissionDenied { path }` field.
    #[error("Operation '{operation}' is not yet supported on Android.")]
    OperationUnsupportedOnAndroid { operation: String },

    /// #416: sync-state SQLite / serialization / blob-store failure.
    /// Catch-all for the sync metadata layer; carries a plain message
    /// because the frontend never routes on it (sync runs in the
    /// background and surfaces a status bar, not a per-error toast).
    #[error("Sync state error: {msg}")]
    SyncState { msg: String },
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
            Self::PathOutsideVault { .. } => "PathOutsideVault",
            Self::VaultPermissionRevoked { .. } => "VaultPermissionRevoked",
            Self::EncryptionUnsupportedOnAndroid => "EncryptionUnsupportedOnAndroid",
            Self::OperationUnsupportedOnAndroid { .. } => "OperationUnsupportedOnAndroid",
            Self::SyncState { .. } => "SyncState",
        }
    }

    pub fn extra_data(&self) -> Option<String> {
        // Exhaustive on purpose — no wildcard arm. Adding a new variant
        // forces the author to decide whether `data` is a routable path
        // (then add it to the `Some(path.clone())` arm) or carries a
        // human message via `Display` only (then add it to the `None`
        // arm). Rust's compile error is the safety net.
        match self {
            Self::FileNotFound { path }
            | Self::PermissionDenied { path }
            | Self::VaultUnavailable { path }
            | Self::MergeConflict { path }
            | Self::InvalidEncoding { path }
            | Self::PathLocked { path }
            | Self::PayloadTooLarge { path, .. }
            | Self::PathOutsideVault { path } => Some(path.clone()),
            // VaultPermissionRevoked carries a URI rather than a path,
            // but the IPC `data` semantic is "string the frontend can
            // act on" — the re-pick UX uses it directly. Same idiom.
            Self::VaultPermissionRevoked { uri } => Some(uri.clone()),
            // OperationUnsupportedOnAndroid carries a human-readable
            // operation name as `data` — frontend renders it inline in
            // the toast copy. Not a path, but still "string the frontend
            // can act on" by the convention above.
            Self::OperationUnsupportedOnAndroid { operation } => Some(operation.clone()),
            // Data-less variants — and variants whose payload is a human
            // message rather than a routable path. The `data` IPC field
            // is reserved for paths the frontend can `navigate(err.data)`,
            // so messages stay in `Display` (the IPC `message` field).
            Self::DiskFull
            | Self::IndexCorrupt
            | Self::IndexLocked
            | Self::LockPoisoned
            | Self::Io(_)
            | Self::WrongPassword
            | Self::CryptoError { .. }
            | Self::PickerFailed { .. }
            | Self::EncryptionUnsupportedOnAndroid
            | Self::SyncState { .. } => None,
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
