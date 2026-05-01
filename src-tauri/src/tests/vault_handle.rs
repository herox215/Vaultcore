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
