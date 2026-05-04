//! TDD coverage for #417 identity layer.

use crate::sync::identity::{derive_device_id, Identity, MemoryKeyStore};
use crate::sync::vault_id;

use tempfile::TempDir;

#[test]
fn device_id_is_stable_across_loads() {
    // First call: generates + persists.
    let store = MemoryKeyStore::new();
    let id1 = Identity::load_or_create(&store).expect("load_or_create #1");
    let did1 = id1.device_id().to_string();
    let pub1 = id1.public_key_bytes();

    // Second call against the same store: must yield the *same* device_id.
    let id2 = Identity::load_or_create(&store).expect("load_or_create #2");
    assert_eq!(id2.device_id(), did1, "device_id must be stable");
    assert_eq!(id2.public_key_bytes(), pub1, "pubkey must be stable");

    // device_id derivation is deterministic from the pubkey.
    let derived = derive_device_id(id2.verifying_key());
    assert_eq!(derived, did1);

    // A *different* store yields a *different* device_id (no shared global state).
    let store_other = MemoryKeyStore::new();
    let id_other = Identity::load_or_create(&store_other).expect("other store");
    assert_ne!(id_other.device_id(), did1);

    // pubkey_fp is the first 8 chars of device_id.
    assert_eq!(id1.pubkey_fp(), &did1[..8]);
}

#[test]
fn vault_id_generated_on_first_call_and_persists() {
    let tmp = TempDir::new().unwrap();
    let metadata_dir = tmp.path().join(".vaultcore");

    let id1 = vault_id::load_or_create(&metadata_dir).expect("first load");
    // Canonical hyphenated UUIDv4 is 36 chars including dashes.
    assert_eq!(id1.len(), 36);
    assert_eq!(id1.matches('-').count(), 4);

    // File must exist on disk.
    let path = metadata_dir.join("vault-id");
    assert!(path.exists(), "vault-id file must be created");
    let raw = std::fs::read_to_string(&path).unwrap();
    assert_eq!(raw.trim(), id1);

    // Second call returns the same id (no rotation).
    let id2 = vault_id::load_or_create(&metadata_dir).expect("second load");
    assert_eq!(id1, id2, "vault-id must persist across calls");

    // Tolerates trailing whitespace / newline a user might paste in.
    std::fs::write(&path, format!("{id1}\n")).unwrap();
    let id3 = vault_id::load_or_create(&metadata_dir).expect("post-newline load");
    assert_eq!(id1, id3);

    // Corrupt content surfaces as an error, never as silent regeneration.
    std::fs::write(&path, "not-a-uuid").unwrap();
    let res = vault_id::load_or_create(&metadata_dir);
    assert!(res.is_err(), "corrupt vault-id must error");
}

#[test]
fn signing_round_trips() {
    use ed25519_dalek::{Signature, Verifier};

    let store = MemoryKeyStore::new();
    let id = Identity::load_or_create(&store).unwrap();

    let msg = b"pair-handshake-001";
    let sig_bytes = id.sign(msg);
    let sig = Signature::from_bytes(&sig_bytes);
    id.verifying_key()
        .verify(msg, &sig)
        .expect("self signature must verify");

    // Tampering breaks verification.
    let tampered = b"pair-handshake-002";
    assert!(id.verifying_key().verify(tampered, &sig).is_err());
}
