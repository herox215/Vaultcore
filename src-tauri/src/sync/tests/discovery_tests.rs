//! TDD coverage for #417 discovery layer (desktop mDNS).
//!
//! Skipped on Android — there's nothing to exercise without a JNI bridge.

#![cfg(not(target_os = "android"))]

use std::time::{Duration, Instant};

use crate::sync::discovery::{
    AdvertisedVault, Discovery, MdnsDiscovery, PeerAd, PROTO_VERSION,
};

fn ad(device_id: &str, name: &str, port: u16) -> PeerAd {
    PeerAd {
        device_id: device_id.to_string(),
        name: name.to_string(),
        vaults: vec![AdvertisedVault {
            id: "vault-uuid-test".into(),
            name: "Test Vault".into(),
        }],
        pubkey_fp: device_id.chars().take(8).collect(),
        proto: PROTO_VERSION.to_string(),
        addrs: Vec::new(),
        port,
    }
}

/// Two `MdnsDiscovery` instances on loopback should observe each other
/// within 5s. Uses two distinct daemon instances so each registers its
/// own service entry on the same machine (mdns-sd handles loopback).
#[test]
fn mdns_advertiser_and_listener_loopback_finds_each_other() {
    let alice = MdnsDiscovery::new().expect("alice daemon");
    let bob = MdnsDiscovery::new().expect("bob daemon");

    alice
        .start(ad("ALICEDEVICEIDXXXX", "Alice", 17091))
        .expect("alice start");
    bob.start(ad("BOBDEVICEIDXXXXXX", "Bob", 17092))
        .expect("bob start");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut alice_sees_bob = false;
    let mut bob_sees_alice = false;
    while Instant::now() < deadline && !(alice_sees_bob && bob_sees_alice) {
        std::thread::sleep(Duration::from_millis(150));
        let asnap = alice.peers().expect("alice peers");
        let bsnap = bob.peers().expect("bob peers");
        if asnap.peers.iter().any(|p| p.device_id == "BOBDEVICEIDXXXXXX") {
            alice_sees_bob = true;
        }
        if bsnap.peers.iter().any(|p| p.device_id == "ALICEDEVICEIDXXXX") {
            bob_sees_alice = true;
        }
    }

    let _ = alice.stop();
    let _ = bob.stop();

    assert!(alice_sees_bob, "alice must discover bob within 5s");
    assert!(bob_sees_alice, "bob must discover alice within 5s");
}

/// Cheap, deterministic test of `start`/`stop` symmetry: starting +
/// stopping must not panic and must leave the peers list empty.
#[test]
fn start_stop_cycle_is_idempotent() {
    let d = MdnsDiscovery::new().expect("daemon");
    d.start(ad("CYCLEDEVICEIDXXXX", "Cycle", 17093))
        .expect("start");
    let _ = d.peers().expect("peers after start");
    d.stop().expect("stop");
    let snap = d.peers().expect("peers after stop");
    assert!(snap.peers.is_empty(), "peers must clear on stop");
}
