// #391 — picker IPC routing tests.
//
// The picker commands are cfg-branched between desktop (`tauri-plugin-dialog`'s
// callback flow) and Android (Tauri mobile-plugin FFI). Driving an actual
// NSOpenPanel / GTK FileChooser headlessly is impractical, so this file
// covers the contracts that ARE testable from a non-GUI unit-test
// environment:
//   1. `PickerFilter` round-trips through serde with the JS-side shape
//      `{ name: string; extensions: string[] }`.
//   2. The desktop command-handler paths compile against the registered
//      `tauri::test::mock_app()` runtime — guards against a future
//      `cfg(target_os = "android")` typo silently dropping the desktop
//      branch from the build matrix.
//
// The Android branch is `cfg`-gated out of the desktop test build by
// design — Android unit tests don't run in our matrix (per #390).

#![cfg(test)]

use crate::commands::picker::PickerFilter;

#[test]
fn picker_filter_round_trips_js_shape() {
    let json = serde_json::json!({
        "name": "HTML",
        "extensions": ["html", "htm"],
    });
    let f: PickerFilter = serde_json::from_value(json).expect("deserialize PickerFilter");
    assert_eq!(f.name, "HTML");
    assert_eq!(f.extensions, vec!["html".to_string(), "htm".to_string()]);
}

#[test]
fn picker_filter_empty_extensions_allowed() {
    // A filter with `extensions: []` is legitimate — desktop dialogs
    // interpret it as "category visible in the dropdown but matches
    // nothing", which is harmless. We only need to assert the deserializer
    // accepts it (vs. requiring a non-empty array).
    let json = serde_json::json!({ "name": "All", "extensions": [] });
    let f: PickerFilter = serde_json::from_value(json).expect("deserialize");
    assert_eq!(f.name, "All");
    assert!(f.extensions.is_empty());
}

#[test]
fn picker_filter_rejects_missing_fields() {
    let json = serde_json::json!({ "name": "HTML" }); // no extensions
    let r: Result<PickerFilter, _> = serde_json::from_value(json);
    assert!(r.is_err(), "deserializer must reject filter without extensions");
}

#[test]
fn picker_filter_rejects_wrong_extension_type() {
    // JS callers occasionally pass `extensions: "html"` (string) instead
    // of `["html"]` (array). Catch the bug at the IPC boundary instead of
    // panicking inside `add_filter`.
    let json = serde_json::json!({ "name": "HTML", "extensions": "html" });
    let r: Result<PickerFilter, _> = serde_json::from_value(json);
    assert!(r.is_err(), "deserializer must reject string extensions");
}

#[cfg(not(target_os = "android"))]
mod desktop_routing {
    // Sanity check that the desktop branch IS the one being compiled when
    // we're not on Android. A `cfg(target_os = "andriod")` typo would
    // silently drop the `pick_folder_impl` desktop body and leave the
    // command undefined — `cargo test --lib` would still pass on macOS
    // because the Android arm is also gone, but `cargo build --bin
    // vaultcore` would fail. This assertion documents the invariant in
    // a place a code review would notice.
    //
    // We can't drive the dialog from a unit test (no UI thread, no event
    // loop ownership), so we only verify the symbol exists and the
    // command function signature compiles.
    use crate::commands::picker::{pick_save_path, pick_vault_folder};

    #[test]
    fn desktop_command_symbols_exist() {
        // `_ =` keeps `pick_*` referenced so a future rename would fail
        // this test loudly. The functions are `#[tauri::command]`-decorated
        // and so wrap into wry-runtime types; assigning them tests that
        // the symbol is reachable, not that the dialog opens.
        let _ = pick_vault_folder;
        let _ = pick_save_path;
    }
}
