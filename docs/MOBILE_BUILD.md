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
- **NDK r26+** — Tauri 2.10 has been verified against `ndk;28.2.13676358`.
- **JDK 17** — Android Studio bundles `jbr` (`/Applications/Android Studio.app/Contents/jbr/Contents/Home` on macOS).
- **Rust targets:**
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
  ```
- **Environment variables:**
  ```bash
  export ANDROID_HOME=$HOME/Library/Android/sdk         # macOS default
  export NDK_HOME=$ANDROID_HOME/ndk/<version>           # e.g. 28.2.13676358
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
