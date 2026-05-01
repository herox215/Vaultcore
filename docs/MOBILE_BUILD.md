# Mobile build (#390)

## Status

**Android-only.** iOS deferred until an Apple Developer Account is acquired
(separate future ticket). The Rust entry point (`src-tauri/src/lib.rs`) is
already cfg-clean for both platforms, so re-introducing iOS is a matter of
running `pnpm tauri ios init` and adding an `ios.json` capability file — no
backend rewrite.

## Prerequisites (Android)

- **Android Studio** Hedgehog (2023.1) or newer (or `cmdline-tools` if you do not want the IDE).
- **Android SDK Platform 34** (matches Tauri's generated `compileSdk = 36` floor; install 34+).
- **Build Tools** (matching your installed Platform).
- **NDK r26** — pinned to `ndk;26.3.11579264` so local and CI builds resolve identical toolchains. Newer NDKs are not what CI exercises.
- **JDK 17** — Android Studio bundles `jbr` (`/Applications/Android Studio.app/Contents/jbr/Contents/Home` on macOS).
- **Rust targets** (all four — Tauri's `RustPlugin.kt` builds the universal flavor including the x86 ABI, so omitting `i686-linux-android` makes the local build fail):
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
  ```
- **Environment variables:**
  ```bash
  export ANDROID_HOME=$HOME/Library/Android/sdk         # macOS default
  export NDK_HOME=$ANDROID_HOME/ndk/26.3.11579264       # match CI
  ```
  `pnpm tauri android` reads `NDK_HOME` (falls back to `ANDROID_NDK_HOME`).

## Commands

| Command | Purpose |
|---|---|
| `pnpm tauri android dev` | Run on emulator / connected device. Tauri injects per-target NDK clang as the `cc` linker. |
| `pnpm tauri android build --debug` | Produce a debug APK (path below). |
| `pnpm tauri android build` | Release build — currently fails without a configured signing key (deferred). |

Debug APK output (Tauri 2.10):
```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Inspect the APK manifest:
```bash
$ANDROID_HOME/build-tools/<version>/aapt2 dump badging <path-to-apk>
$ANDROID_HOME/build-tools/<version>/aapt2 dump permissions <path-to-apk>
```
Expected `package: name='com.vaultcore.app'`. Permissions list should match
`src-tauri/capabilities/mobile.json` — no desktop-only entries.

Install on a connected device / running emulator:
```bash
adb install <path-to-apk>
```

## Verification protocol

| Gate | Command | What it catches |
|---|---|---|
| Fast (auxiliary) | `cargo check --target aarch64-linux-android -p vaultcore --lib` | Dependency-level compile errors. **Does NOT exercise `build.rs` / `tauri-build` runtime.** |
| Authoritative | `pnpm tauri android build --debug` | Full build pipeline. The real gate. |
| Desktop regression | `pnpm tauri build` (existing flow) | Must still produce same artifacts as before #390. **Non-negotiable.** |

The fast gate is cheap; run it on every commit that touches `src-tauri/`. The
authoritative gate runs in CI (see `.github/workflows/build.yml`).

## Signing

Debug builds use a per-machine debug keystore that Gradle auto-generates at
`~/.android/debug.keystore` if missing. **It is intentionally not committed**
— each contributor signs locally. This also means a release-built-by-A APK
will not "install over" a release-built-by-B APK without uninstall, which is
fine for current development.

Release signing is deferred to a future ticket, alongside Play Store
submission. When that lands, the release keystore lives outside the repo
(env var or CI secret) and is referenced from `gen/android/app/build.gradle.kts`.

## iOS (deferred)

Blocker: no Apple Developer Account. Without one we can build for iOS Simulator
only (still useful — limits scope to functional verification). When acquired:

1. Run `pnpm tauri ios init` (generates `src-tauri/gen/apple/`).
2. Add an `ios.json` capability mirroring `mobile.json` with
   `"platforms": ["iOS"]`.
3. Update this doc with iOS prerequisites (Xcode 15+, iOS 17 simulator).
4. `cfg(target_os = "ios")` blocks in Rust if any platform-specific divergence
   is needed (none expected — the entry point is already
   `#[cfg_attr(mobile, tauri::mobile_entry_point)]`).

## CI

`.github/workflows/build.yml` runs two jobs on every PR touching
`src-tauri/` or the frontend:

- `desktop` — `cargo test -p vaultcore --lib` on Linux.
- `android` — `pnpm tauri android build --debug` on Linux, asserts APK
  exists and `aapt2 dump permissions` shows no desktop-only leakage.

The Android job sets up the SDK via `android-actions/setup-android@v3`,
caches `~/.gradle/caches`, and uses `Swatinem/rust-cache@v2` for the cargo
target dir.

Cold-cache CI run estimate: ~15–20 min. Warm-cache: ~5–8 min.

## Custom Android plugins

Custom Kotlin plugin code lives directly in
`src-tauri/gen/android/app/src/main/java/com/vaultcore/app/`.

Tauri 2.10 has no functional overlay-directory mechanism — `src-tauri/android/`
is silently ignored, so files there never reach the build. Empirically tested
with Tauri 2.10.3: `pnpm tauri android init` does not sweep arbitrary `.kt`
files in the package directory, so manually-added plugins survive re-init.
If a future Tauri version changes this behavior the file(s) must be
re-applied after `init`.

Tracked custom plugins:

| File | Ticket | Purpose |
|---|---|---|
| `PickerPlugin.kt` | #391, #392 | SAF picker + I/O. #391 added `ACTION_OPEN_DOCUMENT_TREE` / `ACTION_CREATE_DOCUMENT`. #392 PR-B added `takePersistableUriPermission`, `hasPersistedPermission`, and the read/write/create/delete/rename/metadata/listDir/exists I/O commands backed by `DocumentFile.fromTreeUri`. |

## Android — feature surface (PR-B v1)

What works:

- Picker → open vault → vault re-opens across app restart (the SAF tree URI is persisted via `takePersistableUriPermission` and restored from `recent-vaults.json`).
- Read / edit / save markdown files. Bytes round-trip through `ContentResolver` per file (see Performance below).
- Create / delete / rename / move files. Same-parent rename via `DocumentFile.renameTo`; cross-parent rename uses `DocumentsContract.moveDocument` (requires the SAF provider to advertise `FLAG_SUPPORTS_MOVE` — most stock providers do).
- Create / delete folders. Recursive folder delete via `DocumentFile.delete`; Android 11+ moves the deleted document to the OS Files-app Trash, so user-level recovery is preserved without an in-vault `.trash` subfolder.
- File tree (`list_directory`) populates lazily as the user navigates.
- Bookmarks persist across sessions in app-private scratch (`<getFilesDir()>/vaults/<sha256(uri)[..16]>/bookmarks.json`).
- Stale-bookmark UX: revoking the SAF grant via system Settings (or reinstalling the app) surfaces a `VaultPermissionRevoked` error; the frontend automatically re-fires `pickVaultFolder` so the user can re-grant access without retyping.

Known limitations (tracked follow-ups):

- **No live file watching.** The `notify` crate uses inotify which doesn't reach `content://` URIs. Vault refreshes happen on close + reopen for now. Tracked: `feat(watcher): Android polling fallback for content-URI vaults`.
- **Fulltext search starts empty on each session.** Tantivy's cold-start indexer walks the vault with `walkdir` + `std::fs::read`, which is impractical over `ContentResolver`. Per-file index updates via `dispatch_self_write` populate the index as the user opens/edits files (so search hits show up incrementally). Tracked: `feat(indexer): cold-start lazy index for ContentResolver vaults`.
- **Backlinks and link graph are empty on Android.** Same root cause as the indexer — they require a full vault walk. The frontend's "Outgoing links" panel and graph view show empty states. Tracked under the same lazy-index follow-up.
- **No encrypted folders on Android (#345).** The encryption manifest is canonical-path-keyed (`encryption/mod.rs:185`); a URI-aware variant requires manifest format changes. `encrypt_folder` / `unlock_folder` / `lock_folder` / `lock_all_folders` / `list_encrypted_folders` / `export_decrypted_file` all return `EncryptionUnsupportedOnAndroid`. Plain (unencrypted) vaults work in full. Tracked: `feat(crypto): VaultStorage-aware encryption layer for Android`.
- **HTML export deferred on Android.** Asset-inlining requires walkdir + raw `std::fs::read`. Returns `PermissionDenied` with a clear message. The frontend's "Export to HTML" menu entry should be hidden on Android in a UI-only follow-up.
- **Templates / snippets / canvas / tags / wiki-link counter** all return empty/no-op on Android. Each is a power-user feature whose POSIX-only walkdir hot path didn't earn a port in PR-B.
- **Per-file ContentResolver round-trip cost.** Each `walkRel` step is one Binder call (1-5ms). 5-deep paths cost 5-25ms. Acceptable for v1; batch-API optimization is a UAT-driven follow-up.
- **No in-vault `.trash` subfolder on Android.** SAF doesn't expose a portable trash semantic; relying on the OS-level Files-app Trash on Android 11+ is the v1 strategy.

## Known limitations (tracked, deferred)

- `env_logger::init()` writes to stdout. Logcat does not surface stdout by
  default — to see backend logs in `adb logcat`, swap to the `android_logger`
  crate. Polish-level, deferred.
- `rayon` thread pool inherits CPU-count default. Low-core Android devices
  may benefit from an explicit cap. Polish-level, deferred.
- `purge_legacy_semantic_toggle_file` (best-effort, missing-file safe) may
  log a permission-denied on Android 11+ SELinux configurations — harmless,
  the function swallows it.
- Desktop and Android share `com.vaultcore.app` as bundle ID. If the project
  ever publishes both to stores under that exact identifier, the platforms
  cannot coexist on a device with overlapping data dirs. Flagged for #74
  follow-up if/when stores enter scope.
