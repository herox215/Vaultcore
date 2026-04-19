//! `EmbeddingService` (#194, rewritten for #205) — single-instance,
//! thread-safe text → 384-d pipeline. Owns a `tokenizers::Tokenizer` and an
//! `ort::Session` directly (no fastembed wrapper), so we control session
//! options — specifically `memory_pattern=false` and
//! `arena_extend_strategy=kSameAsRequested` (see `session.rs`).
//!
//! The session is held behind a Mutex because `ort::Session::run` takes
//! `&mut self`, matching fastembed's previous `TextEmbedding` which wasn't
//! `Sync` either.

use std::path::Path;
use std::sync::{Arc, Mutex};

use ndarray::{Array1, Array2, Axis};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams, TruncationStrategy};

use super::session::{build_minilm_session, register_cpu_arena_if_needed};
use super::{ensure_runtime_initialized, model_dir, EmbeddingError};

/// MiniLM-L6-v2 output dimensionality. Matches `embeddings::vector_index::DIM`.
const EMBED_DIM: usize = 384;

/// Matches the tokenizer cap fastembed used via `with_max_length(256)` and
/// MiniLM's training `max_seq_length`.
const MAX_SEQ_LEN: usize = 256;

pub struct EmbeddingService {
    inner: Mutex<Inner>,
}

struct Inner {
    tokenizer: Tokenizer,
    session: Session,
    /// Some MiniLM exports omit `token_type_ids` (all-MiniLM is BERT-style
    /// and always has it, but we probe to stay portable to alternative
    /// models bundled via `VAULTCORE_MODEL_DIR`).
    need_token_type_ids: bool,
}

impl EmbeddingService {
    /// Load the bundled MiniLM model. Triggers `ensure_runtime_initialized`
    /// and registers the env-level CPU arena allocator before building the
    /// session — both are idempotent.
    pub fn load(resource_dir: Option<&Path>) -> Result<Arc<Self>, EmbeddingError> {
        ensure_runtime_initialized(resource_dir)?;
        register_cpu_arena_if_needed()?;

        let dir = model_dir(resource_dir)?;
        let onnx_bytes = std::fs::read(dir.join("model.onnx"))?;
        let session = build_minilm_session(&onnx_bytes)?;

        let need_token_type_ids = session
            .inputs()
            .iter()
            .any(|i| i.name() == "token_type_ids");

        let tokenizer_bytes = std::fs::read(dir.join("tokenizer.json"))?;
        let mut tokenizer = Tokenizer::from_bytes(&tokenizer_bytes)
            .map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
        // Override tokenizer.json's baked-in caps (training-time Fixed-128
        // padding + max_length-128 truncation — see chunking.rs) so the
        // tokenizer can pad/truncate at MAX_SEQ_LEN instead.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_SEQ_LEN,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: tokenizers::TruncationDirection::Right,
            }))
            .map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            direction: tokenizers::PaddingDirection::Right,
            pad_to_multiple_of: None,
            pad_id: 0,
            pad_type_id: 0,
            pad_token: "[PAD]".to_string(),
        }));

        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                tokenizer,
                session,
                need_token_type_ids,
            }),
        }))
    }

    /// Embed a single string. Returns a 384-d L2-normalised vector.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let mut batch = self.embed_batch(&[text])?;
        batch
            .pop()
            .ok_or_else(|| EmbeddingError::Inference("empty embedding batch".into()))
    }

    /// Embed a batch of strings in one inference pass. Returns one 384-d
    /// L2-normalised vector per input, in the same order.
    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| EmbeddingError::Inference("mutex poisoned".into()))?;
        let Inner {
            tokenizer,
            session,
            need_token_type_ids,
        } = &mut *guard;

        let owned: Vec<String> = texts.iter().map(|s| (*s).to_string()).collect();
        let encodings = tokenizer
            .encode_batch(owned, true)
            .map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;

        let batch = encodings.len();
        let seq_len = encodings
            .iter()
            .map(|e| e.get_ids().len())
            .max()
            .unwrap_or(0);
        if seq_len == 0 {
            return Ok(vec![vec![0.0; EMBED_DIM]; batch]);
        }

        let mut input_ids = Array2::<i64>::zeros((batch, seq_len));
        let mut attn_mask = Array2::<i64>::zeros((batch, seq_len));
        let mut type_ids = Array2::<i64>::zeros((batch, seq_len));
        for (row, enc) in encodings.iter().enumerate() {
            for (col, &id) in enc.get_ids().iter().enumerate() {
                input_ids[[row, col]] = id as i64;
            }
            for (col, &m) in enc.get_attention_mask().iter().enumerate() {
                attn_mask[[row, col]] = m as i64;
            }
            for (col, &t) in enc.get_type_ids().iter().enumerate() {
                type_ids[[row, col]] = t as i64;
            }
        }

        let ids_tensor = Tensor::from_array(input_ids)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;
        let attn_tensor = Tensor::from_array(attn_mask.clone())
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;
        let mut inputs: Vec<(&str, SessionInputValue<'_>)> = vec![
            ("input_ids", ids_tensor.into()),
            ("attention_mask", attn_tensor.into()),
        ];
        let type_tensor;
        if *need_token_type_ids {
            type_tensor = Tensor::from_array(type_ids)
                .map_err(|e| EmbeddingError::Inference(e.to_string()))?;
            inputs.push(("token_type_ids", type_tensor.into()));
        }

        let outputs = session
            .run(inputs)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        // MiniLM exports expose the token-level hidden states either as
        // `last_hidden_state` (standard HF export) or as `output_0` / the
        // first output (some quantised exports strip names). Pick the first
        // 3-D float output to stay robust.
        let (_name, first) = outputs
            .iter()
            .find(|(_, v)| {
                v.try_extract_tensor::<f32>()
                    .map(|(shape, _)| shape.len() == 3)
                    .unwrap_or(false)
            })
            .ok_or_else(|| {
                EmbeddingError::Inference("no 3-D f32 output in session result".into())
            })?;
        let (shape, data) = first
            .try_extract_tensor::<f32>()
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;
        if shape.len() != 3 {
            return Err(EmbeddingError::Inference(format!(
                "expected [batch, seq, hidden] but got shape {shape:?}"
            )));
        }
        let (b, s, h) = (shape[0] as usize, shape[1] as usize, shape[2] as usize);
        if b != batch || s != seq_len || h != EMBED_DIM {
            return Err(EmbeddingError::Inference(format!(
                "unexpected output shape [{b}, {s}, {h}] for batch={batch} seq={seq_len} hidden={EMBED_DIM}"
            )));
        }

        // Mean-pool across seq axis, masked by attention_mask, then L2.
        let mut out = Vec::with_capacity(batch);
        for bi in 0..batch {
            let mut pooled = Array1::<f32>::zeros(EMBED_DIM);
            let mut count: f32 = 0.0;
            for si in 0..seq_len {
                let m = attn_mask[[bi, si]];
                if m == 0 {
                    continue;
                }
                count += 1.0;
                let base = (bi * seq_len + si) * EMBED_DIM;
                for hi in 0..EMBED_DIM {
                    pooled[hi] += data[base + hi];
                }
            }
            if count > 0.0 {
                pooled.mapv_inplace(|x| x / count);
            }
            let norm = pooled
                .view()
                .map(|x| x * x)
                .sum_axis(Axis(0))
                .into_scalar()
                .sqrt();
            if norm > f32::EPSILON {
                pooled.mapv_inplace(|x| x / norm);
            }
            out.push(pooled.to_vec());
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // Allow tiny numeric drift from pooling order; real identity
        // expected since the input tensor is identical.
        for (a, b) in single.iter().zip(batch[0].iter()) {
            assert!((a - b).abs() < 1e-5, "drift between single and batch: {a} vs {b}");
        }
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
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EmbeddingService>();
        assert_send_sync::<Arc<EmbeddingService>>();
    }
}
