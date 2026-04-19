//! Local embeddings stack — gated behind the `embeddings` Cargo feature.
//!
//! This module owns the dlopen'd ONNX Runtime lifecycle and the discovery of
//! the bundled embedding model (multilingual-e5-small INT8 since #233; was
//! all-MiniLM-L6-v2 INT8 before — swapped because MiniLM is English-only and
//! collapsed non-English queries onto a noise-floor band). Higher-level
//! services (#194 EmbeddingService, #198 VectorIndex, #203 hybrid search)
//! build on top of `init_runtime` + `model_dir`.
//!
//! Path resolution order for both the runtime dylib and the model directory:
//!
//! 1. Explicit env override (`ORT_DYLIB_PATH`, `VAULTCORE_MODEL_DIR`) — used
//!    by the smoke test and by developers running against a non-bundled
//!    runtime.
//! 2. The Tauri `resource_dir()` (production install).
//! 3. `CARGO_MANIFEST_DIR/resources/...` as a dev fallback for `cargo run`
//!    and `cargo test`, since `resource_dir()` is unreliable in dev builds
//!    (tauri-apps/tauri#13654) and undefined for unit tests with no AppHandle.
//!
//! ORT's `init_from(path).commit()` is global per process and silently
//! returns `false` on the second call — we wrap it in a `OnceLock` so any
//! number of test entry points can call `ensure_runtime_initialized()` without
//! racing or double-initializing.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(feature = "embeddings")]
mod service;
#[cfg(feature = "embeddings")]
pub use service::EmbeddingService;

#[cfg(feature = "embeddings")]
mod session;

#[cfg(feature = "embeddings")]
mod chunking;
#[cfg(feature = "embeddings")]
pub use chunking::{Chunk, Chunker, DEFAULT_OVERLAP_TOKENS, MAX_CONTENT_TOKENS};

#[cfg(feature = "embeddings")]
mod sink;
#[cfg(feature = "embeddings")]
pub use sink::{HnswSink, NoopSink, VectorSink};

#[cfg(feature = "embeddings")]
mod embed_coordinator;
#[cfg(feature = "embeddings")]
pub use embed_coordinator::{EmbedCoordinator, EmbedOp, EnqueueError, WAKEUP_CAPACITY};

#[cfg(feature = "embeddings")]
mod vector_index;
#[cfg(feature = "embeddings")]
pub use vector_index::{VectorIndex, DEFAULT_EF_SEARCH, DIM};

#[cfg(feature = "embeddings")]
mod reindex;
#[cfg(feature = "embeddings")]
pub use reindex::{
    start_reindex, start_reindex_with_backpressure, ReindexHandle, ReindexPhase,
    ReindexProgress, CHECKPOINT_FILE, CHECKPOINT_VERSION,
};

#[cfg(feature = "embeddings")]
mod query;
#[cfg(feature = "embeddings")]
pub use query::{semantic_search_query, QueryHandles, SemanticHit};

#[cfg(feature = "embeddings")]
mod hybrid;
#[cfg(feature = "embeddings")]
pub use hybrid::{rrf_fuse, FusedHit, RRF_K};

#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    #[error("ONNX Runtime dylib not found at any candidate path")]
    RuntimeMissing,
    #[error("Model directory not found at any candidate path")]
    ModelMissing,
    #[error("ONNX Runtime init failed: {0}")]
    OrtInit(String),
    #[error("inference error: {0}")]
    Inference(String),
    #[error("tokenizer error: {0}")]
    Tokenizer(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

const ENV_DYLIB: &str = "ORT_DYLIB_PATH";
const ENV_MODEL_DIR: &str = "VAULTCORE_MODEL_DIR";

/// Platform-specific dylib filename as bundled by build.rs into
/// `resources/onnxruntime/`. Versioned suffixes are kept so we can
/// dlopen via absolute path and bypass SONAME / install-name resolution.
/// Must stay in sync with `resources/checksums.toml`.
fn dylib_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.1.23.2.dylib"
    } else {
        "libonnxruntime.so.1.23.2"
    }
}

/// Resolve the libonnxruntime path. See module docs for resolution order.
///
/// `resource_dir` may be `None` when called outside a Tauri AppHandle context
/// (e.g. `cargo test`) — the dev fallback then takes over.
pub fn runtime_path(resource_dir: Option<&Path>) -> Result<PathBuf, EmbeddingError> {
    if let Some(p) = std::env::var_os(ENV_DYLIB) {
        return Ok(PathBuf::from(p));
    }
    let name = dylib_name();
    if let Some(dir) = resource_dir {
        let p = dir.join("onnxruntime").join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("onnxruntime")
        .join(name);
    if dev.exists() {
        return Ok(dev);
    }
    Err(EmbeddingError::RuntimeMissing)
}

/// Wire the embeddings runtime into a Tauri AppHandle's setup hook.
/// Idempotent and non-fatal — failures only emit a `log::warn!`, so the
/// rest of the app still launches when no dylib is bundled (dev builds,
/// CI without resources, etc.).
pub fn bootstrap(app: &tauri::AppHandle) -> Result<(), EmbeddingError> {
    use tauri::Manager;
    let resource_dir = app.path().resource_dir().ok();
    ensure_runtime_initialized(resource_dir.as_deref())
}

/// Resolve the bundled model directory. Same resolution semantics as
/// `runtime_path`. The directory must contain `model.onnx`,
/// `tokenizer.json`, `config.json`, `tokenizer_config.json`, and
/// `special_tokens_map.json` (#192).
pub fn model_dir(resource_dir: Option<&Path>) -> Result<PathBuf, EmbeddingError> {
    if let Some(p) = std::env::var_os(ENV_MODEL_DIR) {
        return Ok(PathBuf::from(p));
    }
    let leaf = Path::new("models").join("multilingual-e5-small-int8");
    if let Some(dir) = resource_dir {
        let p = dir.join(&leaf);
        if p.exists() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(&leaf);
    if dev.exists() {
        return Ok(dev);
    }
    Err(EmbeddingError::ModelMissing)
}

static RUNTIME_INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// Idempotent global ORT init. The first caller wins; subsequent callers
/// see the same outcome. Safe across threads and across multiple test entry
/// points within a single `cargo test` process.
pub fn ensure_runtime_initialized(
    resource_dir: Option<&Path>,
) -> Result<(), EmbeddingError> {
    let result = RUNTIME_INIT.get_or_init(|| {
        let path = match runtime_path(resource_dir) {
            Ok(p) => p,
            Err(e) => return Err(e.to_string()),
        };
        #[cfg(feature = "embeddings")]
        {
            use ort::environment::GlobalThreadPoolOptions;
            let builder = match ort::init_from(path.to_string_lossy().into_owned()) {
                Ok(b) => b,
                Err(e) => return Err(format!("ort::init_from failed: {e}")),
            };
            // #197: cap ORT inference at 2 intra-op + 1 inter-op threads
            // via a dedicated ORT-managed pool. Installing this on the
            // env triggers `DisablePerSessionThreads` in every session's
            // commit path, so no per-session thread config is needed.
            // The cap keeps embed-on-save from contending with Tantivy's
            // rayon pool for cores under bulk-save bursts.
            let pool_opts = match GlobalThreadPoolOptions::default()
                .with_intra_threads(2)
                .and_then(|o| o.with_inter_threads(1))
            {
                Ok(o) => o,
                Err(e) => return Err(format!("ORT thread-pool config failed: {e}")),
            };
            let builder = builder.with_global_thread_pool(pool_opts);
            // `commit` returns `false` if a global environment already exists.
            // That is not a hard error for us (idempotent init across tests
            // and Tauri setup callbacks), so we don't fail the OnceLock —
            // the cached config still applies for the env that did win.
            if !builder.commit() {
                log::warn!(
                    "ORT environment already committed; #197 thread-pool caps may not apply"
                );
            }
            Ok(())
        }
        #[cfg(not(feature = "embeddings"))]
        {
            let _ = path;
            Err("embeddings feature not enabled".to_string())
        }
    });
    result.clone().map_err(EmbeddingError::OrtInit)
}

/// Smoke-test entry point used by tests/embeddings.rs. Loads the bundled
/// embedding model, embeds a fixed string, and returns the raw 384-dim
/// vector. Uses `embed_passage` so the e5 prefix protocol is exercised
/// end-to-end — the smoke test then doubles as a "tokenizer accepts the
/// `passage: ` prefix without choking" check. The caller (the test) asserts
/// vector length and L2 norm. Returns `Err(ModelMissing)` cleanly if the
/// model isn't bundled yet (#192 not done) so the test can skip.
#[cfg(feature = "embeddings")]
pub fn smoke_test(resource_dir: Option<&Path>) -> Result<Vec<f32>, EmbeddingError> {
    let svc = EmbeddingService::load(resource_dir)?;
    svc.embed_passage("VaultCore semantic search smoke test")
}
