// #392 — `VaultHandle` parse / accessor / equality round-trips.
// PR-B extends this with `ContentUri` arm coverage.

#![cfg(test)]

use crate::storage::VaultHandle;
use std::path::PathBuf;
use tempfile::TempDir;

#[test]
fn parse_canonicalizes_a_real_path() {
    let dir = TempDir::new().unwrap();
    let h = VaultHandle::parse(&dir.path().to_string_lossy()).unwrap();
    let canonical = std::fs::canonicalize(dir.path()).unwrap();
    assert_eq!(h, VaultHandle::Posix(canonical));
}

#[test]
fn parse_missing_path_maps_to_vault_unavailable() {
    let r = VaultHandle::parse("/totally/nonexistent/path-for-test");
    match r {
        Err(crate::error::VaultError::VaultUnavailable { path }) => {
            assert_eq!(path, "/totally/nonexistent/path-for-test");
        }
        other => panic!("expected VaultUnavailable, got {other:?}"),
    }
}

#[test]
fn as_str_round_trips_through_parse() {
    let dir = TempDir::new().unwrap();
    let h1 = VaultHandle::parse(&dir.path().to_string_lossy()).unwrap();
    let s = h1.as_str().into_owned();
    let h2 = VaultHandle::parse(&s).unwrap();
    assert_eq!(h1, h2);
}

#[test]
fn expect_posix_returns_inner_path() {
    let dir = TempDir::new().unwrap();
    let canonical = std::fs::canonicalize(dir.path()).unwrap();
    let h = VaultHandle::Posix(canonical.clone());
    assert_eq!(h.expect_posix(), canonical.as_path());
}

#[test]
fn from_pathbuf_wraps_as_posix() {
    let p = PathBuf::from("/tmp/whatever");
    let h: VaultHandle = p.clone().into();
    assert_eq!(h, VaultHandle::Posix(p));
}

#[test]
fn canonical_dedup_key_for_posix_is_path_string() {
    let h = VaultHandle::Posix(PathBuf::from("/Users/lu/Vault"));
    assert_eq!(h.canonical_dedup_key(), "/Users/lu/Vault");
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use crate::error::VaultError;

    #[test]
    fn parse_content_uri_skips_canonicalize() {
        let uri = "content://com.android.externalstorage.documents/tree/primary%3AVault";
        let h = VaultHandle::parse(uri).unwrap();
        assert_eq!(h, VaultHandle::ContentUri(uri.to_string()));
    }

    #[test]
    fn content_uri_round_trips_through_parse() {
        let uri = "content://com.android.externalstorage.documents/tree/primary%3AVault";
        let h1 = VaultHandle::parse(uri).unwrap();
        let s = h1.as_str().into_owned();
        let h2 = VaultHandle::parse(&s).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn dedup_key_strips_trailing_slash() {
        let a = VaultHandle::ContentUri(
            "content://provider/tree/primary%3AVault".into(),
        );
        let b = VaultHandle::ContentUri(
            "content://provider/tree/primary%3AVault/".into(),
        );
        assert_eq!(a.canonical_dedup_key(), b.canonical_dedup_key());
    }

    #[test]
    fn dedup_key_lowercases_authority_only() {
        let a = VaultHandle::ContentUri(
            "content://Com.Android.Storage/tree/Primary%3AVault".into(),
        );
        let b = VaultHandle::ContentUri(
            "content://com.android.storage/tree/Primary%3AVault".into(),
        );
        // Authority is lowercased, but the path component (incl.
        // percent-encoded `Primary%3A`) is preserved as-is — SAF treats
        // the path as case-sensitive.
        assert_eq!(a.canonical_dedup_key(), b.canonical_dedup_key());
        assert!(a.canonical_dedup_key().contains("Primary%3A"));
    }

    #[test]
    #[should_panic(expected = "expect_posix called on ContentUri")]
    fn expect_posix_panics_on_content_uri() {
        let h = VaultHandle::ContentUri("content://x/tree/y".into());
        let _ = h.expect_posix();
    }

    #[test]
    fn parse_non_content_string_still_canonicalizes() {
        // On Android, a non-content:// string should fall through to
        // POSIX canonicalize and error if the path doesn't exist.
        let r = VaultHandle::parse("/totally/missing");
        match r {
            Err(VaultError::VaultUnavailable { .. }) => {}
            other => panic!("expected VaultUnavailable, got {other:?}"),
        }
    }
}
