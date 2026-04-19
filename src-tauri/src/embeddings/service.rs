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

/// Embedding output dimensionality — 384 for both MiniLM-L6 and
/// multilingual-e5-small. Matches `embeddings::vector_index::DIM`.
const EMBED_DIM: usize = 384;

/// Tokenizer cap. Both bundled models train at 512, but VaultCore notes
/// rarely exceed 256 tokens per chunk and we keep the lower cap to bound
/// peak memory + latency under bulk reindex (#205 budget). Chunking
/// (`chunking.rs`) is sized accordingly.
const MAX_SEQ_LEN: usize = 256;

/// e5 prefix protocol (#233). The intfloat/multilingual-e5 family was
/// trained with these literal prefixes — applying them lets the model put
/// queries and passages in the same retrieval-friendly subspace. Stripping
/// them, or using the same one for both, measurably degrades retrieval.
/// See: https://huggingface.co/intfloat/multilingual-e5-small#faq
const E5_QUERY_PREFIX: &str = "query: ";
const E5_PASSAGE_PREFIX: &str = "passage: ";

pub struct EmbeddingService {
    inner: Mutex<Inner>,
}

struct Inner {
    tokenizer: Tokenizer,
    session: Session,
    /// Some exports omit `token_type_ids` (BERT-style models declare it,
    /// XLM-RoBERTa-style — including e5 — does not). We probe the session
    /// inputs to stay portable across both families and any future model
    /// bundled via `VAULTCORE_MODEL_DIR`.
    need_token_type_ids: bool,
}

impl EmbeddingService {
    /// Load the bundled embedding model. Triggers `ensure_runtime_initialized`
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
        // Resolve pad token from the tokenizer's own vocab — XLM-RoBERTa
        // (e5) uses `<pad>` (id 1), BERT-style (MiniLM) uses `[PAD]` (id 0).
        // Hardcoding either silently corrupts attention on the other family
        // by padding with a real content token. Probe both candidates and
        // pick the first one the vocab knows.
        let (pad_token, pad_id) = ["<pad>", "[PAD]"]
            .iter()
            .find_map(|t| tokenizer.token_to_id(t).map(|id| ((*t).to_string(), id)))
            .ok_or_else(|| {
                EmbeddingError::Tokenizer(
                    "tokenizer vocab declares neither <pad> nor [PAD]".into(),
                )
            })?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            direction: tokenizers::PaddingDirection::Right,
            pad_to_multiple_of: None,
            pad_id,
            pad_type_id: 0,
            pad_token,
        }));

        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                tokenizer,
                session,
                need_token_type_ids,
            }),
        }))
    }

    /// Embed a single string verbatim — no e5 prefix is applied. Prefer
    /// `embed_query` / `embed_passage` over this primitive: bare embeds
    /// against e5 land in a different subspace than the indexed passages
    /// and silently degrade retrieval quality. Kept public for benchmarks
    /// and the smoke test, where the prefix is irrelevant.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let mut batch = self.embed_batch(&[text])?;
        batch
            .pop()
            .ok_or_else(|| EmbeddingError::Inference("empty embedding batch".into()))
    }

    /// Embed a user query with the e5 `"query: "` prefix. Use this on the
    /// query path (semantic search input). See module-level e5 prefix note.
    pub fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        self.embed(&format!("{E5_QUERY_PREFIX}{text}"))
    }

    /// Embed an indexed passage with the e5 `"passage: "` prefix. Use this
    /// on the indexing path (every chunk that lands in the vector index).
    pub fn embed_passage(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        self.embed(&format!("{E5_PASSAGE_PREFIX}{text}"))
    }

    /// Batched query embed — same prefix semantics as `embed_query`.
    pub fn embed_query_batch(
        &self,
        texts: &[&str],
    ) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        let prefixed: Vec<String> =
            texts.iter().map(|t| format!("{E5_QUERY_PREFIX}{t}")).collect();
        let refs: Vec<&str> = prefixed.iter().map(|s| s.as_str()).collect();
        self.embed_batch(&refs)
    }

    /// Batched passage embed — same prefix semantics as `embed_passage`.
    /// The indexing pipeline (`reindex.rs`) calls this for every batch.
    pub fn embed_passage_batch(
        &self,
        texts: &[&str],
    ) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        let prefixed: Vec<String> =
            texts.iter().map(|t| format!("{E5_PASSAGE_PREFIX}{t}")).collect();
        let refs: Vec<&str> = prefixed.iter().map(|s| s.as_str()).collect();
        self.embed_batch(&refs)
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

        // ONNX exports expose the token-level hidden states either as
        // `last_hidden_state` (standard HF export) or as `output_0` / the
        // first output (some quantised exports strip names). Pick the first
        // 3-D float output to stay robust across both BERT-style (MiniLM)
        // and XLM-RoBERTa-style (e5) graphs.
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
        // Ask + passage prefixes — mirrors the production query path so we
        // benchmark the actual subspace the index uses.
        let a = svc.embed_query("how do cats communicate").unwrap();
        let b = svc.embed_passage("feline body language").unwrap();
        let c = svc.embed_passage("rust async runtime internals").unwrap();
        let cos = |x: &[f32], y: &[f32]| -> f32 {
            x.iter().zip(y).map(|(a, b)| a * b).sum()
        };
        let close = cos(&a, &b);
        let far = cos(&a, &c);
        // Margin calibrated for multilingual-e5-small (#233): the model
        // uses a tighter cosine range than MiniLM did — same *ordering*,
        // smaller absolute gap. 0.05 keeps the semantic signal clear
        // while not being miscalibrated for the current model.
        assert!(
            close > far + 0.05,
            "expected close > far + 0.05, got close={close}, far={far}"
        );
    }

    #[test]
    fn service_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EmbeddingService>();
        assert_send_sync::<Arc<EmbeddingService>>();
    }

    /// #207 AC #1 — single-note embed latency p50/p99. Warm, steady-state
    /// (ORT session already loaded, arena stable). Emits a JSON line to
    /// stderr for `scripts/run-benchmarks.sh` to collect.
    ///
    /// `#[ignore]` because it needs the bundled model and should only
    /// run through the benchmark harness. Run with:
    /// `cargo test --release --features embeddings -- --ignored bench_single_embed --nocapture`.
    #[test]
    #[ignore]
    fn bench_single_embed_p50_p99() {
        use std::time::{Duration, Instant};
        const WARMUP: usize = 20;
        const N: usize = 200;

        let Some(svc) = try_load() else {
            eprintln!("SKIP: embeddings not bundled");
            return;
        };

        // Representative prose — varied length so we exercise the tokenizer's
        // padding + truncation paths, not just the shortest possible input.
        let probes: Vec<String> = (0..N)
            .map(|i| {
                format!(
                    "note {i} about markdown workflows, cross-linking between \
                     files, and incremental indexing of a personal knowledge vault"
                )
            })
            .collect();
        for p in probes.iter().take(WARMUP) {
            let _ = svc.embed(p).unwrap();
        }

        let mut samples = Vec::with_capacity(N);
        for p in &probes {
            let t0 = Instant::now();
            let _ = svc.embed(p).unwrap();
            samples.push(t0.elapsed());
        }
        samples.sort();
        let p50 = samples[N / 2];
        let p99 = samples[(N * 99) / 100];
        eprintln!("BENCH_JSON {{\"name\":\"single_embed\",\"p50_ms\":{:.3},\"p99_ms\":{:.3},\"n\":{N}}}",
            p50.as_secs_f64() * 1000.0,
            p99.as_secs_f64() * 1000.0);
        // Loose ceiling: 20 ms p50 was the MiniLM-era headroom; e5-small
        // is ~5x larger so warm p50 climbs accordingly. We raise the cap
        // to 100 ms as an absolute sanity ceiling — the real regression
        // detector is `scripts/bench-regression.py` against `baseline.json`.
        assert!(
            p50 < Duration::from_millis(100),
            "single_embed p50 too slow: {p50:?}"
        );
    }
}
