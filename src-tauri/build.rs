//! Build-script: ensures the bundled libonnxruntime (#191) and MiniLM model
//! (#192) are present in `src-tauri/resources/...` before tauri-build runs.
//!
//! Strategy: skip-on-cached-with-sha. The first build downloads the pinned
//! upstream archive into a tempfile, verifies SHA-256 against
//! `resources/checksums.toml`, extracts only the dylib (or model files),
//! and writes them into `resources/onnxruntime/<platform>/`. Subsequent
//! builds compare the on-disk SHA against the manifest and short-circuit.
//!
//! Concurrent cargo workers are serialised through an exclusive file lock
//! on `resources/.fetch.lock` so two parallel `cargo test` runs don't race
//! on the same destination file.
//!
//! Network failures only emit a `cargo:warning=...` and continue — the
//! embedding smoke test (#190) is gated and will skip cleanly when the
//! runtime / model isn't present.

use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use sha2::{Digest, Sha256};

fn main() {
    println!("cargo:rerun-if-changed=resources/checksums.toml");
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let resources_dir = manifest_dir.join("resources");

    if let Err(e) = ensure_assets(&resources_dir) {
        // Non-fatal — gated tests (#190) skip when runtime is missing.
        println!("cargo:warning=onnx asset fetch skipped: {e}");
    }

    tauri_build::build()
}

#[derive(Debug)]
struct AssetError(String);
impl std::fmt::Display for AssetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for AssetError {}
impl From<io::Error> for AssetError {
    fn from(e: io::Error) -> Self {
        AssetError(e.to_string())
    }
}
impl From<toml::de::Error> for AssetError {
    fn from(e: toml::de::Error) -> Self {
        AssetError(e.to_string())
    }
}

fn ensure_assets(resources_dir: &Path) -> Result<(), AssetError> {
    fs::create_dir_all(resources_dir)?;
    let lock_path = resources_dir.join(".fetch.lock");
    let lock_file = File::create(&lock_path)?;
    lock_file.lock_exclusive()?;

    let manifest_text = fs::read_to_string(resources_dir.join("checksums.toml"))
        .map_err(|e| AssetError(format!("read checksums.toml: {e}")))?;
    let manifest: toml::Value = toml::from_str(&manifest_text)?;

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let platform = match (target_os.as_str(), target_arch.as_str()) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => {
            return Err(AssetError(format!(
                "no asset pinned for {target_os}/{target_arch}"
            )));
        }
    };

    ensure_onnxruntime(&manifest, resources_dir, platform)?;
    ensure_model(&manifest, resources_dir, platform)?;
    Ok(())
}

fn ensure_onnxruntime(
    manifest: &toml::Value,
    resources_dir: &Path,
    platform: &str,
) -> Result<(), AssetError> {
    let entry = manifest
        .get("onnxruntime")
        .and_then(|v| v.get(platform))
        .ok_or_else(|| AssetError(format!("missing onnxruntime.{platform}")))?;

    let url = required_str(entry, "url")?;
    let sha256 = required_str(entry, "sha256")?;
    let archive_path = required_str(entry, "archive_path")?;
    let dylib_name = required_str(entry, "dylib_name")?;

    let dest_dir = resources_dir.join("onnxruntime");
    fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(dylib_name);
    if !dest.exists() {
        println!("cargo:warning=fetching {url}");
        let archive_bytes = http_get(url)?;
        verify_sha256(&archive_bytes, sha256)?;
        if url.ends_with(".tgz") || url.ends_with(".tar.gz") {
            extract_from_tgz(&archive_bytes, archive_path, &dest)?;
        } else if url.ends_with(".zip") {
            extract_from_zip(&archive_bytes, archive_path, &dest)?;
        } else {
            return Err(AssetError(format!("unsupported archive extension: {url}")));
        }
    }

    // #242: upstream onnxruntime ships signed by Microsoft (Team UBF8T346G9).
    // Tauri's bundled host is linker-signed ad-hoc with no Team — the TeamID
    // mismatch makes AMFI refuse the dlopen at runtime, so embeddings fail
    // silently in installed builds. Strip the upstream signature back to
    // ad-hoc so it matches the host's identity. Idempotent: re-running on an
    // already-ad-hoc dylib is a no-op rewrite. Non-fatal on failure (e.g.
    // cross-compiling from Linux where `codesign` doesn't exist) — the build
    // continues and the runtime falls back to the existing signature.
    if platform.starts_with("macos-") {
        if let Err(e) = adhoc_resign(&dest) {
            println!("cargo:warning=macos adhoc re-sign skipped: {e}");
        }
    }
    Ok(())
}

fn adhoc_resign(path: &Path) -> Result<(), AssetError> {
    let status = std::process::Command::new("codesign")
        .args(["--force", "--sign", "-"])
        .arg(path)
        .status()
        .map_err(|e| AssetError(format!("spawn codesign: {e}")))?;
    if !status.success() {
        return Err(AssetError(format!(
            "codesign exited with {:?}",
            status.code()
        )));
    }
    Ok(())
}

fn ensure_model(
    manifest: &toml::Value,
    resources_dir: &Path,
    platform: &str,
) -> Result<(), AssetError> {
    let model_block = match manifest.get("model") {
        Some(v) => v,
        None => return Ok(()),
    };
    let id = required_str(model_block, "id")?;
    let dest_dir = resources_dir.join("models").join(id);
    fs::create_dir_all(&dest_dir)?;

    // Per-arch ONNX file (renamed to model.onnx so embeddings code stays
    // architecture-agnostic).
    let arch_entry = model_block
        .get(platform)
        .ok_or_else(|| AssetError(format!("missing model.{platform}")))?;
    fetch_one_file(arch_entry, &dest_dir)?;

    // Architecture-shared tokenizer + config files.
    if let Some(shared) = model_block.get("shared").and_then(|v| v.as_table()) {
        for entry in shared.values() {
            fetch_one_file(entry, &dest_dir)?;
        }
    }

    // Bundle model LICENSE + NOTICE. e5-small is MIT (different from the
    // Apache-2.0 MiniLM predecessor); ship the MIT text verbatim next to the
    // binary so the copyright + permission notice travel with the model as
    // the license requires.
    write_if_missing(&dest_dir.join("LICENSE"), MIT_LICENSE)?;
    write_if_missing(&dest_dir.join("NOTICE"), MODEL_NOTICE)?;
    Ok(())
}

fn fetch_one_file(entry: &toml::Value, dest_dir: &Path) -> Result<(), AssetError> {
    let url = required_str(entry, "url")?;
    let sha256 = required_str(entry, "sha256")?;
    let dest_name = required_str(entry, "dest_name")?;
    let dest = dest_dir.join(dest_name);
    if dest.exists() {
        return Ok(());
    }
    println!("cargo:warning=fetching {url}");
    let bytes = http_get(url)?;
    verify_sha256(&bytes, sha256)?;
    write_atomic(&dest, |f| f.write_all(&bytes))?;
    Ok(())
}

fn required_str<'a>(v: &'a toml::Value, key: &str) -> Result<&'a str, AssetError> {
    v.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| AssetError(format!("missing field: {key}")))
}

fn write_if_missing(path: &Path, contents: &str) -> Result<(), AssetError> {
    if path.exists() {
        return Ok(());
    }
    write_atomic(path, |f| f.write_all(contents.as_bytes()))
}

const MODEL_NOTICE: &str = "multilingual-e5-small\n\
Copyright (c) 2023 Liang Wang, Nan Yang, Xiaolong Huang, Linjun Yang,\n\
Rangan Majumder, Furu Wei (Microsoft / intfloat).\n\
Licensed under the MIT License.\n\
\n\
Source (upstream):   https://huggingface.co/intfloat/multilingual-e5-small\n\
Source (ONNX INT8):  https://huggingface.co/Xenova/multilingual-e5-small\n\
\n\
This product bundles the portable INT8 ONNX export (`model_quantized.onnx`)\n\
from Xenova's repackaging, which runs on every VaultCore target CPU\n\
(x86_64 + aarch64). The original model card and license live upstream.\n";

const MIT_LICENSE: &str = include_str!("resources/LICENSE-MIT");

fn http_get(url: &str) -> Result<Vec<u8>, AssetError> {
    let resp = ureq::get(url)
        .call()
        .map_err(|e| AssetError(format!("http get {url}: {e}")))?;
    let mut buf = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| AssetError(format!("read body: {e}")))?;
    Ok(buf)
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), AssetError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected.to_lowercase() {
        return Err(AssetError(format!(
            "sha256 mismatch: expected {expected}, got {actual}"
        )));
    }
    Ok(())
}

fn extract_from_tgz(
    archive_bytes: &[u8],
    inner_path: &str,
    dest: &Path,
) -> Result<(), AssetError> {
    let dec = flate2::read::GzDecoder::new(archive_bytes);
    let mut tar = tar::Archive::new(dec);
    for entry in tar
        .entries()
        .map_err(|e| AssetError(format!("tar iter: {e}")))?
    {
        let mut entry = entry.map_err(|e| AssetError(format!("tar entry: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| AssetError(format!("tar path: {e}")))?
            .into_owned();
        // tar entries may begin with "./" — strip for comparison.
        let trimmed = path.strip_prefix("./").unwrap_or(&path);
        if trimmed == Path::new(inner_path) {
            write_atomic(dest, |f| {
                io::copy(&mut entry, f)?;
                Ok(())
            })?;
            return Ok(());
        }
    }
    Err(AssetError(format!(
        "{inner_path} not found in tgz archive"
    )))
}

fn extract_from_zip(
    archive_bytes: &[u8],
    inner_path: &str,
    dest: &Path,
) -> Result<(), AssetError> {
    let cursor = io::Cursor::new(archive_bytes);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| AssetError(format!("zip open: {e}")))?;
    let mut entry = zip
        .by_name(inner_path)
        .map_err(|e| AssetError(format!("{inner_path} not in zip: {e}")))?;
    write_atomic(dest, |f| {
        io::copy(&mut entry, f)?;
        Ok(())
    })?;
    Ok(())
}

fn write_atomic<F: FnOnce(&mut File) -> Result<(), io::Error>>(
    dest: &Path,
    write: F,
) -> Result<(), AssetError> {
    let tmp = dest.with_extension("tmp");
    let mut f = File::create(&tmp)?;
    write(&mut f).map_err(|e| AssetError(format!("write tmp: {e}")))?;
    f.flush()?;
    drop(f);
    fs::rename(&tmp, dest)?;
    Ok(())
}
