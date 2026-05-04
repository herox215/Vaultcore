fn main() {
    // `ci_no_mdns` is a custom cfg flag set when CI environments block
    // multicast — used by `tests/sync_e2e.rs` to fall back to direct
    // peer-address override. Declared here so rustc's check-cfg lint
    // doesn't warn about it on every build.
    println!("cargo::rustc-check-cfg=cfg(ci_no_mdns)");
    tauri_build::build();
}
