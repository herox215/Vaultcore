// #392 — `VaultHandle` is the cross-platform identifier for a vault root.
//
// On desktop and dev it wraps a canonicalized POSIX path. PR-B will add a
// `ContentUri(String)` arm for Android Storage Access Framework tree URIs;
// it is intentionally absent from PR-A so the type wrapper stays pure
// scaffolding (zero behavior change) and reviewers can focus on the
// mechanical 22-site migration.
//
// The handle serializes to a string for IPC + recent-vaults persistence.
// On desktop the string form is the path's display string, identical to
// what callers used to pass around as a bare `PathBuf::display()`.

use crate::error::VaultError;
use std::borrow::Cow;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultHandle {
    /// Desktop / dev: a canonicalized POSIX path.
    Posix(PathBuf),
    // ContentUri(String) — added in PR-B for Android. Cfg-gated then.
}

impl VaultHandle {
    /// Stable string form for IPC + recent-vaults persistence.
    pub fn as_str(&self) -> Cow<'_, str> {
        match self {
            Self::Posix(p) => p.to_string_lossy(),
        }
    }

    /// Parse from a string supplied by the picker / read from
    /// recent-vaults.json. PR-A always treats the input as a POSIX path
    /// and canonicalizes — same behavior as today's `open_vault`. PR-B
    /// adds a `content://` heuristic for Android tree URIs.
    pub fn parse(s: &str) -> Result<Self, VaultError> {
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

    /// Panicking accessor for the 22 PR-A sites that still operate on
    /// `&Path`. PR-B replaces every caller with either a `VaultStorage`
    /// trait call or a cfg-gated branch; the panicking shape exists so
    /// a regression on Android is loud, not silent. Single grep target
    /// for PR-B: `expect_posix`.
    pub fn expect_posix(&self) -> &Path {
        match self {
            Self::Posix(p) => p.as_path(),
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
