// SHA-256 content hashing helper. EDIT-10 groundwork per D-19 — the Phase 5
// plan will use this exact function to compare pre-save on-disk hashes against
// expected hashes to detect external modifications. Phase 1 only uses it as
// the return value of write_file so the hash-write pattern is established
// from day one.

use sha2::{Digest, Sha256};

/// SHA-256 of the given bytes as a lowercase hex string.
pub fn hash_bytes(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_empty_matches_known_value() {
        // Known SHA-256 of empty input (NIST test vector)
        assert_eq!(
            hash_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hash_changes_with_content() {
        assert_ne!(hash_bytes(b"a"), hash_bytes(b"b"));
    }

    #[test]
    fn hash_hello_matches_known_value() {
        // Known SHA-256 of "hello"
        assert_eq!(
            hash_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
