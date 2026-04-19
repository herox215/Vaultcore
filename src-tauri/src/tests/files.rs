// Wave 1 files.rs unit tests — D-17 UTF-8 guard, T-02 vault-scope guard,
// SHA-256 write return value, FileNotFound path.
//
// These tests drive `_impl` helpers that mirror the body of the
// `#[tauri::command]` functions in `commands/files.rs`. The duplication is
// intentional: `tauri::State` cannot be constructed outside a running Tauri
// app, so there's no way to call the real command body from a `cargo test`
// binary. The two code paths MUST stay logically identical.

use crate::error::VaultError;
use crate::VaultState;
use std::fs;
use tempfile::tempdir;

fn tokio_test_block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

fn state_with_vault(root: &std::path::Path) -> VaultState {
    // Use the real canonical form so starts_with() works the same way the
    // production command path would.
    let canonical = fs::canonicalize(root).unwrap();
    let s = VaultState::default();
    *s.current_vault.lock().unwrap() = Some(canonical);
    s
}

// --- read_file ------------------------------------------------------------

#[test]
fn read_file_returns_utf8_content() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("hello.md");
    fs::write(&path, "# Hello").unwrap();
    let state = state_with_vault(dir.path());
    let result =
        tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into_owned()));
    assert_eq!(result.unwrap(), "# Hello");
}

#[test]
fn read_file_rejects_non_utf8_as_invalid_encoding() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bin.md");
    // 0xff 0xfe is not valid UTF-8 (it's a UTF-16 BOM).
    fs::write(&path, [0xff, 0xfe, 0x00, 0x01]).unwrap();
    let state = state_with_vault(dir.path());
    let result =
        tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into_owned()));
    match result {
        Err(VaultError::InvalidEncoding { path: p }) => assert!(p.contains("bin.md")),
        other => panic!("expected InvalidEncoding, got {:?}", other),
    }
}

#[test]
fn read_file_rejects_path_outside_vault() {
    let vault_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();
    let outside_path = outside_dir.path().join("secret.md");
    fs::write(&outside_path, "secret").unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = tokio_test_block_on(read_file_impl(
        &state,
        outside_path.to_string_lossy().into_owned(),
    ));
    match result {
        Err(VaultError::PermissionDenied { .. }) => {}
        other => panic!("expected PermissionDenied, got {:?}", other),
    }
}

#[test]
fn read_file_returns_file_not_found_for_missing_path() {
    let vault_dir = tempdir().unwrap();
    let missing = vault_dir.path().join("does-not-exist.md");
    let state = state_with_vault(vault_dir.path());
    let result = tokio_test_block_on(read_file_impl(
        &state,
        missing.to_string_lossy().into_owned(),
    ));
    match result {
        Err(VaultError::FileNotFound { .. }) => {}
        other => panic!("expected FileNotFound, got {:?}", other),
    }
}

// --- write_file -----------------------------------------------------------

#[test]
fn write_file_writes_bytes_and_returns_hash() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.md");
    let state = state_with_vault(dir.path());
    let hash = tokio_test_block_on(write_file_impl(
        &state,
        path.to_string_lossy().into_owned(),
        "hello".into(),
    ))
    .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    // Known SHA-256 of "hello"
    assert_eq!(
        hash,
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}

#[test]
fn write_file_rejects_path_outside_vault() {
    let vault_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();
    let state = state_with_vault(vault_dir.path());
    let result = tokio_test_block_on(write_file_impl(
        &state,
        outside_dir
            .path()
            .join("evil.md")
            .to_string_lossy()
            .into_owned(),
        "pwn".into(),
    ));
    match result {
        Err(VaultError::PermissionDenied { .. }) => {}
        other => panic!("expected PermissionDenied, got {:?}", other),
    }
}

#[test]
fn write_file_round_trip_with_read_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("round.md");
    let state = state_with_vault(dir.path());
    tokio_test_block_on(write_file_impl(
        &state,
        path.to_string_lossy().into_owned(),
        "roundtrip".into(),
    ))
    .unwrap();
    let contents =
        tokio_test_block_on(read_file_impl(&state, path.to_string_lossy().into_owned()))
            .unwrap();
    assert_eq!(contents, "roundtrip");
}

// --- #196 embed-on-save: save-RTT regression -----------------------------

/// Regression guard for #196 AC: "Save-RTT unverändert". The embed hook is
/// sync, non-blocking, and must add far less than the 16 ms keystroke
/// budget to a single save. We assert the median of 100 saves with a
/// no-op-sink coordinator stays within 1 ms of the median without one.
/// 1 ms is generous on purpose so CI noise doesn't flake; if this trips,
/// profile the hook — something is doing unexpected work.
#[cfg(feature = "embeddings")]
#[test]
fn embed_hook_does_not_regress_save_rtt() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    tokio_test_block_on(async {
        async fn run(state: &VaultState, dir: &std::path::Path, label: &str) -> Duration {
            const N: usize = 100;
            let mut samples = Vec::with_capacity(N);
            for i in 0..N {
                let path = dir.join(format!("{label}-{i}.md"));
                let t0 = Instant::now();
                write_file_impl(
                    state,
                    path.to_string_lossy().into_owned(),
                    format!("rtt sample {i}\n").repeat(20),
                )
                .await
                .unwrap();
                samples.push(t0.elapsed());
            }
            samples.sort();
            samples[N / 2]
        }

        // Baseline: no embed coordinator registered.
        let dir_baseline = tempdir().unwrap();
        let state_baseline = state_with_vault(dir_baseline.path());
        let median_no_hook = run(&state_baseline, dir_baseline.path(), "noop").await;

        // With hook: register a coordinator backed by a NoopSink. Skip
        // cleanly if the model isn't bundled (CI without resources).
        let Some(svc) = crate::embeddings::EmbeddingService::load(None).ok() else {
            eprintln!("SKIP: embeddings not bundled");
            return;
        };
        let Some(chk) = crate::embeddings::Chunker::load(None).ok() else {
            eprintln!("SKIP: tokenizer not bundled");
            return;
        };
        let dir_hook = tempdir().unwrap();
        let state_hook = state_with_vault(dir_hook.path());
        {
            let sink: Arc<dyn crate::embeddings::VectorSink> =
                Arc::new(crate::embeddings::NoopSink);
            let coord = crate::embeddings::EmbedCoordinator::spawn(svc, chk, sink);
            *state_hook.embed_coordinator.lock().unwrap() = Some(coord);
        }
        let median_with_hook = run(&state_hook, dir_hook.path(), "hook").await;

        let delta = median_with_hook.saturating_sub(median_no_hook);
        assert!(
            delta < Duration::from_millis(1),
            "embed hook regressed save RTT: median delta = {delta:?} (baseline {median_no_hook:?}, hook {median_with_hook:?})"
        );
    });
}

/// AC for #197 ("Bulk-Write-Stresstest, 100 Saves in 10 s, no p99
/// keystroke-latency regression"). Spreads 100 saves over ~10 s with a
/// **real** EmbeddingService so the ORT thread-pool cap (`intra=2,
/// inter=1`) is genuinely exercised under sustained inference load. The
/// assertion is a comfortable absolute p99 bound rather than a delta —
/// 50 ms is well below the spec's 100 ms "open note" budget and gives
/// CI noise plenty of headroom while still tripping on a real
/// regression (e.g. fastembed defaulting back to per-session unbounded
/// threads).
///
/// `#[ignore]` because real ML inference is slow and CPU-heavy — opt
/// into it explicitly with `cargo test -- --ignored`.
#[cfg(feature = "embeddings")]
#[test]
#[ignore]
fn save_rtt_p99_under_bulk_embed_pressure() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    tokio_test_block_on(async {
        let Some(svc) = crate::embeddings::EmbeddingService::load(None).ok() else {
            eprintln!("SKIP: embeddings not bundled");
            return;
        };
        let Some(chk) = crate::embeddings::Chunker::load(None).ok() else {
            eprintln!("SKIP: tokenizer not bundled");
            return;
        };
        let dir = tempdir().unwrap();
        let state = state_with_vault(dir.path());
        {
            let sink: Arc<dyn crate::embeddings::VectorSink> =
                Arc::new(crate::embeddings::NoopSink);
            let coord = crate::embeddings::EmbedCoordinator::spawn(svc, chk, sink);
            *state.embed_coordinator.lock().unwrap() = Some(coord);
        }

        const N: usize = 100;
        const TOTAL: Duration = Duration::from_secs(10);
        let inter_save = TOTAL / N as u32;
        let mut samples = Vec::with_capacity(N);
        for i in 0..N {
            let path = dir.path().join(format!("bulk-{i}.md"));
            let body = format!("bulk save {i}\n").repeat(40);
            let t0 = Instant::now();
            write_file_impl(&state, path.to_string_lossy().into_owned(), body)
                .await
                .unwrap();
            samples.push(t0.elapsed());
            tokio::time::sleep(inter_save).await;
        }
        samples.sort();
        let p99 = samples[(N as f64 * 0.99) as usize - 1];
        assert!(
            p99 < Duration::from_millis(50),
            "save RTT p99 = {p99:?} exceeded 50 ms budget under sustained embed pressure",
        );
    });
}

// --- _impl helpers: mirror the tauri::command bodies ---------------------
//
// Keep these byte-for-byte logically identical to commands/files.rs.

async fn read_file_impl(state: &VaultState, path: String) -> Result<String, VaultError> {
    use std::path::PathBuf;
    let target = PathBuf::from(&path);
    let canonical_target = std::fs::canonicalize(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    {
        let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
        let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
            path: path.clone(),
        })?;
        if !canonical_target.starts_with(vault) {
            return Err(VaultError::PermissionDenied { path });
        }
    }
    let bytes = std::fs::read(&canonical_target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    String::from_utf8(bytes).map_err(|_| VaultError::InvalidEncoding { path })
}

async fn write_file_impl(
    state: &VaultState,
    path: String,
    content: String,
) -> Result<String, VaultError> {
    use std::path::PathBuf;
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::FileNotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path: path.clone() },
        _ => VaultError::Io(e),
    })?;
    {
        let guard = state.current_vault.lock().map_err(|_| VaultError::LockPoisoned)?;
        let vault = guard.as_ref().ok_or_else(|| VaultError::VaultUnavailable {
            path: path.clone(),
        })?;
        if !canonical_parent.starts_with(vault) {
            return Err(VaultError::PermissionDenied { path });
        }
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| VaultError::PermissionDenied { path: path.clone() })?;
    let final_path = canonical_parent.join(file_name);
    let bytes = content.as_bytes();
    std::fs::write(&final_path, bytes).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => VaultError::PermissionDenied { path },
        std::io::ErrorKind::StorageFull => VaultError::DiskFull,
        _ => VaultError::Io(e),
    })?;

    // Mirror commands/files.rs::write_file: dispatch index + embed updates
    // after the disk write succeeds. Both are best-effort and silently
    // skip when the relevant coordinator isn't registered in state.
    dispatch_index_updates_test(state, &final_path, &content).await;
    #[cfg(feature = "embeddings")]
    dispatch_embed_update_test(state, final_path.clone(), &content);

    Ok(crate::hash::hash_bytes(bytes))
}

async fn dispatch_index_updates_test(
    state: &VaultState,
    abs_path: &std::path::Path,
    content: &str,
) {
    use crate::indexer::IndexCmd;
    let vault_root = {
        let Ok(guard) = state.current_vault.lock() else { return };
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => return,
        }
    };
    let Ok(rel) = abs_path.strip_prefix(&vault_root) else { return };
    let rel_path = rel.to_string_lossy().replace('\\', "/");
    let tx = {
        let Ok(guard) = state.index_coordinator.lock() else { return };
        match guard.as_ref() {
            Some(c) => c.tx.clone(),
            None => return,
        }
    };
    let _ = tx
        .send(IndexCmd::UpdateLinks { rel_path: rel_path.clone(), content: content.to_string() })
        .await;
    let _ = tx
        .send(IndexCmd::UpdateTags { rel_path, content: content.to_string() })
        .await;
}

#[cfg(feature = "embeddings")]
fn dispatch_embed_update_test(
    state: &VaultState,
    abs_path: std::path::PathBuf,
    content: &str,
) {
    let handles = {
        let Ok(guard) = state.embed_coordinator.lock() else { return };
        guard.as_ref().map(|c| (c.tx.clone(), std::sync::Arc::clone(&c.pending)))
    };
    let Some((tx, pending)) = handles else { return };
    let probe = crate::embeddings::EmbedCoordinator { tx, pending };
    let _ = probe.enqueue(abs_path, content.to_string());
}
