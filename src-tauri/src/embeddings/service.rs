//! `EmbeddingService` (#194) — single-instance, thread-safe text → 384-d
//! vector pipeline used by every backend caller (embed-on-save, reindex,
//! query). The model is loaded once via fastembed and held behind a Mutex
//! that serialises inference calls. fastembed's `TextEmbedding` is not
//! `Sync` (it owns an `ort::Session` with interior mutability), so the
//! Mutex wrap is required to satisfy `Send + Sync`.

use std::path::Path;
use std::sync::{Arc, Mutex};

use fastembed::{
    InitOptionsUserDefined, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};

use super::{ensure_runtime_initialized, model_dir, EmbeddingError};

/// Bundled-model embedding pipeline. Construct once per process via
/// `EmbeddingService::load`, then share the resulting `Arc` everywhere.
pub struct EmbeddingService {
    inner: Mutex<TextEmbedding>,
}

impl EmbeddingService {
    /// Load the bundled MiniLM model. Wraps the ORT runtime initialisation
    /// so it is safe to call before or after `embeddings::bootstrap`.
    pub fn load(resource_dir: Option<&Path>) -> Result<Arc<Self>, EmbeddingError> {
        ensure_runtime_initialized(resource_dir)?;
        let dir = model_dir(resource_dir)?;
        let read = |name: &str| std::fs::read(dir.join(name));
        let model = UserDefinedEmbeddingModel::new(
            read("model.onnx")?,
            TokenizerFiles {
                tokenizer_file: read("tokenizer.json")?,
                config_file: read("config.json")?,
                special_tokens_map_file: read("special_tokens_map.json")?,
                tokenizer_config_file: read("tokenizer_config.json")?,
            },
        );
        // Cap fastembed's tokenizer at 256 to match MiniLM-L6-v2's training
        // sequence length and the chunker's window size (#195). The crate
        // default is 512, which would let oversized inputs through and
        // silently degrade embedding quality.
        let embedder = TextEmbedding::try_new_from_user_defined(
            model,
            InitOptionsUserDefined::default().with_max_length(256),
        )
        .map_err(|e| EmbeddingError::Fastembed(e.to_string()))?;
        Ok(Arc::new(Self {
            inner: Mutex::new(embedder),
        }))
    }

    /// Embed a single string. Returns a 384-dim L2-normalised vector.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let mut batch = self.embed_batch(&[text])?;
        batch.pop().ok_or_else(|| {
            EmbeddingError::Fastembed("empty embedding batch".into())
        })
    }

    /// Embed a batch of strings in one inference pass.
    pub fn embed_batch(
        &self,
        texts: &[&str],
    ) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| EmbeddingError::Fastembed("mutex poisoned".into()))?;
        let owned: Vec<String> = texts.iter().map(|s| s.to_string()).collect();
        guard
            .embed(owned, None)
            .map_err(|e| EmbeddingError::Fastembed(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: skip when the bundled assets aren't present yet (e.g. on a
    /// fresh checkout where `cargo build` hasn't run).
    fn try_load() -> Option<Arc<EmbeddingService>> {
        EmbeddingService::load(None).ok()
    }

    #[test]
    fn embed_returns_384_l2_normalised_vector() {
        let Some(svc) = try_load() else {
            eprintln!("SKIP: embeddings not bundled");
            return;
        };
        let v = svc.embed("hello world").unwrap();
        assert_eq!(v.len(), 384);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 0.01, "L2 norm: {norm}");
    }

    #[test]
    fn batch_matches_per_item() {
        let Some(svc) = try_load() else {
            eprintln!("SKIP: embeddings not bundled");
            return;
        };
        let single = svc.embed("the quick brown fox").unwrap();
        let batch = svc.embed_batch(&["the quick brown fox"]).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0], single);
    }

    #[test]
    fn semantically_close_strings_have_high_cosine_similarity() {
        let Some(svc) = try_load() else {
            eprintln!("SKIP: embeddings not bundled");
            return;
        };
        let a = svc.embed("how do cats communicate").unwrap();
        let b = svc.embed("feline body language").unwrap();
        let c = svc.embed("rust async runtime internals").unwrap();
        let cos = |x: &[f32], y: &[f32]| -> f32 {
            x.iter().zip(y).map(|(a, b)| a * b).sum()
        };
        let close = cos(&a, &b);
        let far = cos(&a, &c);
        assert!(
            close > far + 0.1,
            "expected close > far + 0.1, got close={close}, far={far}"
        );
    }

    #[test]
    fn service_is_send_and_sync() {
        // Compile-time assertion — if this changes, callers in tokio
        // workers (#196) and rayon (#198) would break.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EmbeddingService>();
        assert_send_sync::<Arc<EmbeddingService>>();
    }
}
