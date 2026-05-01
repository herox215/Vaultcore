// #392 — `VaultHandle` is the cross-platform identifier for a vault root.
//
// PR-A: single `Posix(PathBuf)` arm, scaffolding for PR-B.
// PR-B: adds `ContentUri(String)` arm gated to `target_os = "android"`.
//
// The handle serializes to a string for IPC + recent-vaults persistence.
// On desktop the string form is the path's display string; on Android it
// is the SAF tree URI verbatim (the URI Android handed back from the
// document picker — must NOT be normalized when passed to
// `takePersistableUriPermission`, see `canonical_dedup_key` for the
// recent-vaults dedup form).

use crate::error::VaultError;
use std::borrow::Cow;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultHandle {
    /// Desktop / dev: a canonicalized POSIX path.
    Posix(PathBuf),
    /// Android: SAF tree URI (e.g. `content://com.android.externalstorage.documents/tree/primary%3AVault`).
    /// Stored verbatim — `takePersistableUriPermission` and SAF
    /// document-walk APIs key on byte-equality with the URI Android
    /// originally vended. Use `canonical_dedup_key` for recent-vaults
    /// dedup or any other equality check that should treat trailing
    /// slashes / authority casing as equivalent.
    #[cfg(target_os = "android")]
    ContentUri(String),
}

impl VaultHandle {
    /// Stable string form for IPC + recent-vaults persistence.
    pub fn as_str(&self) -> Cow<'_, str> {
        match self {
            Self::Posix(p) => p.to_string_lossy(),
            #[cfg(target_os = "android")]
            Self::ContentUri(u) => Cow::Borrowed(u),
        }
    }

    /// Parse from a string supplied by the picker / read from
    /// recent-vaults.json. Android branch: `content://` prefix routes to
    /// the URI arm without filesystem I/O. Desktop branch: canonicalize
    /// + map IO errors to `VaultUnavailable` / `PermissionDenied` per
    /// the existing `open_vault` contract.
    pub fn parse(s: &str) -> Result<Self, VaultError> {
        #[cfg(target_os = "android")]
        if s.starts_with("content://") {
            return Ok(Self::ContentUri(s.to_string()));
        }
        let p = PathBuf::from(s);
        let canonical = std::fs::canonicalize(&p).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::VaultUnavailable {
                path: s.to_string(),
            },
            std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied {
                path: s.to_string(),
            },
            _ => VaultError::Io(e),
        })?;
        Ok(Self::Posix(canonical))
    }

    /// Stable equality key for `recent-vaults.json` dedup. Strips a
    /// trailing slash on URIs (Android may or may not return one
    /// depending on provider) and lowercases the authority. Path and
    /// percent-encoding are NOT touched: SAF treats those as
    /// case-sensitive identifiers.
    ///
    /// **Never use this URI to call into Android.** SAF grants are
    /// keyed on byte-equality with the URI Android originally vended;
    /// normalized URIs round-trip through `takePersistableUriPermission`
    /// as a different grant (or no grant at all). Call sites that
    /// invoke SAF must use `as_str()`.
    pub fn canonical_dedup_key(&self) -> String {
        match self {
            Self::Posix(p) => p.to_string_lossy().into_owned(),
            #[cfg(target_os = "android")]
            Self::ContentUri(u) => {
                let trimmed = u.trim_end_matches('/');
                if let Some(scheme_end) = trimmed.find("://") {
                    let (scheme, rest) = trimmed.split_at(scheme_end + 3);
                    if let Some(slash) = rest.find('/') {
                        let (authority, path) = rest.split_at(slash);
                        format!("{}{}{}", scheme, authority.to_lowercase(), path)
                    } else {
                        format!("{}{}", scheme, rest.to_lowercase())
                    }
                } else {
                    trimmed.to_string()
                }
            }
        }
    }

    /// Panicking accessor for the desktop-only call sites that still
    /// operate on `&Path`. The panic message names the grep target so
    /// future migrations are mechanical: `grep -rn expect_posix
    /// src-tauri/src/`. Every site is a candidate for either a
    /// `VaultStorage` trait call or a cfg-gated branch.
    pub fn expect_posix(&self) -> &Path {
        match self {
            Self::Posix(p) => p.as_path(),
            #[cfg(target_os = "android")]
            Self::ContentUri(_) => panic!(
                "expect_posix called on ContentUri vault — code path must \
                 route through VaultStorage trait or be cfg(target_os = \"android\") \
                 gated. Single grep target: `expect_posix`."
            ),
        }
    }
}

impl From<PathBuf> for VaultHandle {
    /// Wrap an already-canonicalized path. Used by tests that build a
    /// `VaultState` directly with a `tempfile::TempDir` path.
    fn from(p: PathBuf) -> Self {
        Self::Posix(p)
    }
}
