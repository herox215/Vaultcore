//! Cross-platform device discovery (epic #73 sub-issue #417).
//!
//! Desktop (macOS / Windows / Linux): `mdns-sd` advertises and browses
//! `_vaultcore._tcp.local.`. Android (out of scope for the desktop bar)
//! is a JNI bridge — currently a stub that panics if instantiated; the
//! NSD JNI work lands separately, integration-tested only on emulator.
//!
//! TXT record schema (epic-locked):
//!   device_id  — base32 device identifier
//!   name       — human-readable device name (default OS hostname)
//!   vaults     — JSON array of `{id, name}`
//!   pubkey_fp  — 8-char fingerprint
//!   proto      — wire-protocol version, currently "1"

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::VaultError;

pub const SERVICE_TYPE: &str = "_vaultcore._tcp.local.";
pub const PROTO_VERSION: &str = "1";

/// Per-vault advertisement payload — paired peers see one row per
/// `(device_id, vault_id)` so they can tap "sync this vault" in the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvertisedVault {
    pub id: String,
    pub name: String,
}

/// Self-description broadcast by `Discovery::start`. Reused for the
/// "what we observe from peers" struct because the wire format is
/// symmetric — the only difference is direction of travel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerAd {
    pub device_id: String,
    pub name: String,
    pub vaults: Vec<AdvertisedVault>,
    pub pubkey_fp: String,
    pub proto: String,
    /// Reachable address(es). Populated from the mDNS A/AAAA records on
    /// receive; ignored on advertise (the advertiser passes its TCP port
    /// separately and `mdns-sd` resolves the local addresses).
    pub addrs: Vec<std::net::IpAddr>,
    pub port: u16,
}

/// Snapshot returned by `Discovery::peers`. Cheap to clone — peers list
/// is single-digit in practice.
#[derive(Debug, Clone, Default)]
pub struct PeerSnapshot {
    pub peers: Vec<PeerAd>,
}

pub trait Discovery: Send + Sync {
    /// Begin advertising `self_ad` and browsing for peers. Idempotent:
    /// calling start twice is a no-op (or refresh — impl decision).
    fn start(&self, self_ad: PeerAd) -> Result<(), VaultError>;
    /// Stop advertising + browsing. Used when the user toggles
    /// "Discoverable on this network" off in Settings.
    fn stop(&self) -> Result<(), VaultError>;
    /// Current observed peers (excluding self).
    fn peers(&self) -> Result<PeerSnapshot, VaultError>;
}

// ─── Desktop impl ─────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
pub use desktop::MdnsDiscovery;

/// Platform-default discovery implementation. Desktop targets get the
/// real `mdns-sd` advertiser/browser; Android falls back to a no-op
/// stub until the NSD JNI bridge ships (epic #73 follow-up). Lets
/// `sync_cmds::SyncRuntime` hold one type across platforms.
#[cfg(not(target_os = "android"))]
pub type DiscoveryImpl = MdnsDiscovery;
#[cfg(target_os = "android")]
pub type DiscoveryImpl = AndroidDiscovery;

#[cfg(not(target_os = "android"))]
mod desktop {
    use super::*;
    use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
    use std::collections::HashMap;
    use std::net::IpAddr;
    use std::sync::{Mutex, RwLock};
    use std::thread;

    const TXT_DEVICE_ID: &str = "device_id";
    const TXT_NAME: &str = "name";
    const TXT_VAULTS: &str = "vaults";
    const TXT_PUBKEY_FP: &str = "pubkey_fp";
    const TXT_PROTO: &str = "proto";

    pub struct MdnsDiscovery {
        daemon: ServiceDaemon,
        /// Service fullname registered with the daemon — kept around so
        /// `stop` can unregister.
        registered: Mutex<Option<String>>,
        /// Latest peer snapshot, updated by the browse thread.
        peers: Arc<RwLock<HashMap<String, PeerAd>>>,
        /// Our own device_id — filtered out of the peers snapshot so the
        /// UI never shows "you" as a discoverable target.
        self_device_id: Mutex<Option<String>>,
        browse_handle: Mutex<Option<thread::JoinHandle<()>>>,
        stop_browse: Arc<std::sync::atomic::AtomicBool>,
    }

    impl MdnsDiscovery {
        pub fn new() -> Result<Self, VaultError> {
            let daemon = ServiceDaemon::new().map_err(|e| VaultError::SyncState {
                msg: format!("mdns daemon init: {e}"),
            })?;
            Ok(Self {
                daemon,
                registered: Mutex::new(None),
                peers: Arc::new(RwLock::new(HashMap::new())),
                self_device_id: Mutex::new(None),
                browse_handle: Mutex::new(None),
                stop_browse: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            })
        }
    }

    impl Discovery for MdnsDiscovery {
        fn start(&self, self_ad: PeerAd) -> Result<(), VaultError> {
            // Record our own device_id so the browse thread can skip it.
            *self
                .self_device_id
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(self_ad.device_id.clone());

            // Build TXT record map. `vaults` carries JSON so it survives
            // intact on the wire.
            let vaults_json =
                serde_json::to_string(&self_ad.vaults).map_err(|e| VaultError::SyncState {
                    msg: format!("serialize vaults TXT: {e}"),
                })?;
            let mut txt: HashMap<String, String> = HashMap::new();
            txt.insert(TXT_DEVICE_ID.into(), self_ad.device_id.clone());
            txt.insert(TXT_NAME.into(), self_ad.name.clone());
            txt.insert(TXT_VAULTS.into(), vaults_json);
            txt.insert(TXT_PUBKEY_FP.into(), self_ad.pubkey_fp.clone());
            txt.insert(TXT_PROTO.into(), self_ad.proto.clone());

            // Service instance name = device_id; mdns-sd uses it to
            // disambiguate multiple advertisers on the same host.
            let host = format!("{}.local.", self_ad.device_id);
            let info = ServiceInfo::new(
                SERVICE_TYPE,
                &self_ad.device_id,
                &host,
                "",
                self_ad.port,
                Some(txt),
            )
            .map_err(|e| VaultError::SyncState {
                msg: format!("mdns ServiceInfo: {e}"),
            })?
            .enable_addr_auto();

            let fullname = info.get_fullname().to_string();
            self.daemon
                .register(info)
                .map_err(|e| VaultError::SyncState {
                    msg: format!("mdns register: {e}"),
                })?;
            *self
                .registered
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(fullname);

            // Spawn a browse thread that drains ServiceEvents into our
            // peers map. The thread terminates when `stop_browse` is set.
            let receiver = self
                .daemon
                .browse(SERVICE_TYPE)
                .map_err(|e| VaultError::SyncState {
                    msg: format!("mdns browse: {e}"),
                })?;
            let peers = Arc::clone(&self.peers);
            let stop_flag = Arc::clone(&self.stop_browse);
            stop_flag.store(false, std::sync::atomic::Ordering::SeqCst);
            let self_id = self_ad.device_id.clone();
            let handle = thread::spawn(move || {
                while !stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    // Bounded poll so we observe `stop_flag` periodically
                    // even under quiet networks.
                    let evt = match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    match evt {
                        ServiceEvent::ServiceResolved(info) => {
                            let txt: HashMap<String, String> = info
                                .get_properties()
                                .iter()
                                .map(|p| (p.key().to_string(), p.val_str().to_string()))
                                .collect();
                            let device_id = match txt.get(TXT_DEVICE_ID) {
                                Some(s) => s.clone(),
                                None => continue,
                            };
                            // Filter out our own advertisement.
                            if device_id == self_id {
                                continue;
                            }
                            let vaults = txt
                                .get(TXT_VAULTS)
                                .and_then(|s| {
                                    serde_json::from_str::<Vec<AdvertisedVault>>(s).ok()
                                })
                                .unwrap_or_default();
                            let ad = PeerAd {
                                device_id: device_id.clone(),
                                name: txt.get(TXT_NAME).cloned().unwrap_or_default(),
                                vaults,
                                pubkey_fp: txt.get(TXT_PUBKEY_FP).cloned().unwrap_or_default(),
                                proto: txt.get(TXT_PROTO).cloned().unwrap_or_default(),
                                addrs: info.get_addresses().iter().copied().collect::<Vec<IpAddr>>(),
                                port: info.get_port(),
                            };
                            if let Ok(mut g) = peers.write() {
                                g.insert(device_id, ad);
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            // fullname is `<instance>.<service>.<domain>`;
                            // the instance segment is the device_id we used.
                            if let Some(instance) = fullname.split('.').next() {
                                if let Ok(mut g) = peers.write() {
                                    g.remove(instance);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            });
            *self
                .browse_handle
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(handle);
            Ok(())
        }

        fn stop(&self) -> Result<(), VaultError> {
            if let Some(name) = self
                .registered
                .lock()
                .map_err(|_| VaultError::LockPoisoned)?
                .take()
            {
                let _ = self.daemon.unregister(&name);
            }
            self.stop_browse
                .store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(h) = self
                .browse_handle
                .lock()
                .map_err(|_| VaultError::LockPoisoned)?
                .take()
            {
                let _ = h.join();
            }
            self.peers
                .write()
                .map_err(|_| VaultError::LockPoisoned)?
                .clear();
            Ok(())
        }

        fn peers(&self) -> Result<PeerSnapshot, VaultError> {
            let g = self.peers.read().map_err(|_| VaultError::LockPoisoned)?;
            Ok(PeerSnapshot {
                peers: g.values().cloned().collect(),
            })
        }
    }

    impl Drop for MdnsDiscovery {
        fn drop(&mut self) {
            let _ = self.stop();
            let _ = self.daemon.shutdown();
        }
    }
}

// ─── Android stub ─────────────────────────────────────────────────────

#[cfg(target_os = "android")]
pub use android::AndroidDiscovery;

#[cfg(target_os = "android")]
mod android {
    use super::*;

    /// Android NSD JNI bridge — integration-tested only on emulator
    /// (epic #73 spec). Stubbed for now; the JNI bindings land in a
    /// follow-up.
    pub struct AndroidDiscovery;

    impl AndroidDiscovery {
        pub fn new() -> Result<Self, VaultError> {
            Ok(Self)
        }
    }

    impl Discovery for AndroidDiscovery {
        // Stubs intentionally Ok-and-empty rather than `unimplemented!()`
        // so the app boots, the Settings → SYNCHRONISIERUNG section
        // renders, and the user can pair via manual peer entry while
        // the NSD JNI bridge lands separately.
        fn start(&self, _self_ad: PeerAd) -> Result<(), VaultError> {
            Ok(())
        }
        fn stop(&self) -> Result<(), VaultError> {
            Ok(())
        }
        fn peers(&self) -> Result<PeerSnapshot, VaultError> {
            Ok(PeerSnapshot::default())
        }
    }
}
