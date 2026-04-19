//! Tokenizer-aware text chunker (#195) — splits long notes into overlapping
//! ≤256-token windows so MiniLM-L6-v2's 256-token sequence cap doesn't
//! become a quality cliff for long documents.
//!
//! Design contract:
//! - Each chunk holds at most `MAX_CONTENT_TOKENS = 254` *content* tokens.
//!   fastembed re-tokenises every input it gets and adds [CLS] + [SEP]
//!   itself, so the on-wire sequence is always ≤256 (the value
//!   `EmbeddingService::load` configures via `with_max_length(256)`).
//! - Consecutive chunks overlap by `DEFAULT_OVERLAP_TOKENS = 32` tokens,
//!   so context that spans a window boundary is still embedded together at
//!   least once.
//! - Per-chunk `byte_offset` is the byte position of `chunk.text[0]` inside
//!   the parent string. The invariant `parent[byte_offset..byte_offset +
//!   text.len()] == text` always holds and is asserted in tests.
//!
//! The chunker holds its own `Tokenizer` instance (separate from the one
//! fastembed loads inside `TextEmbedding`) — fastembed exposes no accessor,
//! and re-loading the bundled `tokenizer.json` (~700 KB) once at startup
//! is cheaper than refactoring `service.rs` to share state.
//!
//! The bundled `tokenizer.json` ships with `truncation.max_length = 128`
//! and `padding.Fixed = 128` baked in (sentence-transformers exports those
//! training-time defaults). We disable both in `load()` — without that
//! step, every chunk would silently cap at 128 tokens.

use std::path::Path;
use std::sync::Arc;

use tokenizers::Tokenizer;

use super::{model_dir, EmbeddingError};

/// Maximum *content* tokens per chunk. Picked so that after fastembed
/// re-tokenises and prepends [CLS] / appends [SEP] (2 special tokens),
/// the on-wire sequence is exactly 256 — matching MiniLM-L6-v2's training
/// `max_seq_length` and the cap configured in `EmbeddingService::load`.
pub const MAX_CONTENT_TOKENS: usize = 254;

/// Default sliding-window overlap. 32/254 ≈ 12 % is the standard RAG
/// trade-off between redundant compute and context preservation across
/// chunk boundaries.
pub const DEFAULT_OVERLAP_TOKENS: usize = 32;

/// One chunk of source text plus its byte offset into the parent string.
///
/// Invariant: `parent[byte_offset..byte_offset + text.len()] == text` for
/// every `Chunk` produced by `Chunker::chunk`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub text: String,
    pub byte_offset: usize,
}

pub struct Chunker {
    tokenizer: Tokenizer,
    max_tokens: usize,
    overlap: usize,
}

impl Chunker {
    /// Load the bundled MiniLM tokenizer with default caps
    /// (`MAX_CONTENT_TOKENS` / `DEFAULT_OVERLAP_TOKENS`). Reuses
    /// `model_dir()` for path resolution so it shares the resource-dir /
    /// env-override / dev-fallback story with `EmbeddingService`.
    pub fn load(resource_dir: Option<&Path>) -> Result<Arc<Self>, EmbeddingError> {
        Self::with_limits(
            resource_dir,
            MAX_CONTENT_TOKENS,
            DEFAULT_OVERLAP_TOKENS,
        )
    }

    /// Load with explicit caps. Useful for tests and for downstream callers
    /// (e.g. #196) that want different windows.
    pub fn with_limits(
        resource_dir: Option<&Path>,
        max_tokens: usize,
        overlap: usize,
    ) -> Result<Arc<Self>, EmbeddingError> {
        if max_tokens == 0 {
            return Err(EmbeddingError::InvalidArgument(
                "max_tokens must be > 0".into(),
            ));
        }
        if overlap >= max_tokens {
            return Err(EmbeddingError::InvalidArgument(format!(
                "overlap ({overlap}) must be < max_tokens ({max_tokens})"
            )));
        }
        let dir = model_dir(resource_dir)?;
        let mut tok = Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
        // The bundled tokenizer.json has truncation.max_length=128 and
        // padding.Fixed=128 baked in. Disable both — chunking is the only
        // place those caps would silently bite us.
        tok.with_truncation(None)
            .map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
        tok.with_padding(None);
        Ok(Arc::new(Self {
            tokenizer: tok,
            max_tokens,
            overlap,
        }))
    }

    /// Split `input` into ≤`max_tokens` content-token chunks with
    /// `overlap`-token slide. Whitespace-only input returns an empty Vec.
    pub fn chunk(&self, input: &str) -> Result<Vec<Chunk>, EmbeddingError> {
        if input.trim().is_empty() {
            return Ok(Vec::new());
        }

        // Encode WITHOUT special tokens — we want only content tokens with
        // byte offsets pointing into `input`. fastembed will re-add
        // [CLS]/[SEP] when it embeds.
        let enc = self
            .tokenizer
            .encode(input, false)
            .map_err(|e| EmbeddingError::Tokenizer(e.to_string()))?;
        let offsets = enc.get_offsets();
        let n = offsets.len();
        if n == 0 {
            return Ok(Vec::new());
        }

        if n <= self.max_tokens {
            return Ok(vec![Chunk {
                text: input.to_string(),
                byte_offset: 0,
            }]);
        }

        let stride = self.max_tokens - self.overlap;
        let mut chunks = Vec::new();
        let mut start_tok = 0usize;
        loop {
            let end_tok = (start_tok + self.max_tokens).min(n);
            let byte_start = offsets[start_tok].0;
            let byte_end = offsets[end_tok - 1].1;
            chunks.push(Chunk {
                text: input[byte_start..byte_end].to_string(),
                byte_offset: byte_start,
            });
            if end_tok == n {
                break;
            }
            start_tok += stride;
        }
        Ok(chunks)
    }

    #[cfg(test)]
    fn token_count(&self, text: &str) -> usize {
        self.tokenizer
            .encode(text, false)
            .map(|e| e.get_ids().len())
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn token_ids(&self, text: &str) -> Vec<u32> {
        self.tokenizer
            .encode(text, false)
            .map(|e| e.get_ids().to_vec())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn try_load() -> Option<Arc<Chunker>> {
        match Chunker::load(None) {
            Ok(c) => Some(c),
            Err(_) => {
                eprintln!("SKIP: tokenizer not bundled");
                None
            }
        }
    }

    /// Build an input that encodes to *exactly* `target` content tokens.
    /// "hello" tokenises to a single WordPiece on MiniLM; we repeat it,
    /// then trim.
    fn synth_input(chunker: &Chunker, target: usize) -> String {
        let mut s = String::new();
        for _ in 0..target {
            if !s.is_empty() {
                s.push(' ');
            }
            s.push_str("hello");
        }
        // Defensive: in case spacing affects pretokenisation, trim down or
        // pad up until token count matches.
        while chunker.token_count(&s) > target {
            let cut = s.rfind(' ').unwrap_or(0);
            s.truncate(cut);
        }
        while chunker.token_count(&s) < target {
            s.push_str(" hello");
        }
        s
    }

    #[test]
    fn chunker_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Chunker>();
        assert_send_sync::<Arc<Chunker>>();
    }

    #[test]
    fn with_limits_rejects_zero_max() {
        let e = Chunker::with_limits(None, 0, 0).err().expect("should error");
        assert!(matches!(e, EmbeddingError::InvalidArgument(_)));
    }

    #[test]
    fn with_limits_rejects_overlap_geq_max() {
        let e = Chunker::with_limits(None, 10, 10).err().expect("should error");
        assert!(matches!(e, EmbeddingError::InvalidArgument(_)));
    }

    #[test]
    fn empty_input_returns_no_chunks() {
        let Some(c) = try_load() else { return };
        assert!(c.chunk("").unwrap().is_empty());
    }

    #[test]
    fn whitespace_only_input_returns_no_chunks() {
        let Some(c) = try_load() else { return };
        assert!(c.chunk("   \n\t  ").unwrap().is_empty());
    }

    #[test]
    fn short_note_returns_single_chunk_with_offset_zero() {
        let Some(c) = try_load() else { return };
        let chunks = c.chunk("hello world").unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].byte_offset, 0);
        assert_eq!(chunks[0].text, "hello world");
    }

    #[test]
    fn boundary_exactly_max_tokens_returns_single_chunk() {
        let Some(c) = try_load() else { return };
        let input = synth_input(&c, MAX_CONTENT_TOKENS);
        assert_eq!(c.token_count(&input), MAX_CONTENT_TOKENS);
        let chunks = c.chunk(&input).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].byte_offset, 0);
        assert_eq!(chunks[0].text, input);
    }

    #[test]
    fn boundary_max_plus_one_returns_two_chunks() {
        let Some(c) = try_load() else { return };
        let input = synth_input(&c, MAX_CONTENT_TOKENS + 1);
        assert_eq!(c.token_count(&input), MAX_CONTENT_TOKENS + 1);
        let chunks = c.chunk(&input).unwrap();
        assert_eq!(chunks.len(), 2, "expected 2 chunks for max+1 tokens");
    }

    #[test]
    fn long_note_chunk_count_matches_window_loop() {
        let Some(c) = try_load() else { return };
        let n = 1000usize;
        let input = synth_input(&c, n);
        let chunks = c.chunk(&input).unwrap();
        // Match the loop semantics exactly: starts at 0, MAX-OVERLAP, ...
        // until end_tok == n.
        let stride = MAX_CONTENT_TOKENS - DEFAULT_OVERLAP_TOKENS;
        let mut expected = 0usize;
        let mut start = 0usize;
        loop {
            expected += 1;
            let end = (start + MAX_CONTENT_TOKENS).min(n);
            if end == n {
                break;
            }
            start += stride;
        }
        assert_eq!(chunks.len(), expected);
    }

    #[test]
    fn boundary_max_plus_stride_returns_two_chunks() {
        let Some(c) = try_load() else { return };
        let n = MAX_CONTENT_TOKENS + (MAX_CONTENT_TOKENS - DEFAULT_OVERLAP_TOKENS);
        let input = synth_input(&c, n);
        let chunks = c.chunk(&input).unwrap();
        assert_eq!(chunks.len(), 2);
    }

    #[test]
    fn offset_invariant_holds_for_every_chunk() {
        let Some(c) = try_load() else { return };
        let input = synth_input(&c, 600);
        let chunks = c.chunk(&input).unwrap();
        for chunk in &chunks {
            let end = chunk.byte_offset + chunk.text.len();
            assert!(input.is_char_boundary(chunk.byte_offset));
            assert!(input.is_char_boundary(end));
            assert_eq!(&input[chunk.byte_offset..end], chunk.text);
        }
    }

    /// Overlap correctness: re-tokenising consecutive chunks against the
    /// parent encoding shows the last `overlap` token IDs of chunk i are
    /// the first `overlap` IDs of chunk i+1.
    #[test]
    fn consecutive_chunks_overlap_by_overlap_tokens() {
        let Some(c) = try_load() else { return };
        let input = synth_input(&c, 800);
        let chunks = c.chunk(&input).unwrap();
        assert!(chunks.len() >= 2);
        for pair in chunks.windows(2) {
            let prev_ids = c.token_ids(&pair[0].text);
            let next_ids = c.token_ids(&pair[1].text);
            let tail = &prev_ids[prev_ids.len() - DEFAULT_OVERLAP_TOKENS..];
            let head = &next_ids[..DEFAULT_OVERLAP_TOKENS];
            assert_eq!(tail, head, "overlap token IDs must match");
        }
    }

    #[test]
    fn multibyte_utf8_offsets_are_codepoint_aligned() {
        let Some(c) = try_load() else { return };
        let mut input = String::new();
        for _ in 0..400 {
            input.push_str("こんにちは 世界 🌍 ");
        }
        let chunks = c.chunk(&input).unwrap();
        assert!(chunks.len() >= 2, "input should split");
        for chunk in &chunks {
            let end = chunk.byte_offset + chunk.text.len();
            assert!(
                input.is_char_boundary(chunk.byte_offset),
                "byte_offset {} not on a char boundary",
                chunk.byte_offset
            );
            assert!(
                input.is_char_boundary(end),
                "end {} not on a char boundary",
                end
            );
            assert_eq!(&input[chunk.byte_offset..end], chunk.text);
        }
    }

    #[test]
    fn with_limits_custom_caps_respected() {
        let Some(_) = try_load() else { return };
        let c = Chunker::with_limits(None, 16, 4).expect("custom load");
        let input = synth_input(&c, 50);
        let chunks = c.chunk(&input).unwrap();
        assert!(chunks.len() >= 2);
        for pair in chunks.windows(2) {
            let prev_ids = c.token_ids(&pair[0].text);
            let next_ids = c.token_ids(&pair[1].text);
            assert!(prev_ids.len() <= 16);
            assert_eq!(&prev_ids[prev_ids.len() - 4..], &next_ids[..4]);
        }
    }

    #[test]
    fn single_token_input_produces_one_chunk() {
        let Some(c) = try_load() else { return };
        let chunks = c.chunk("hello").unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].byte_offset, 0);
        assert_eq!(chunks[0].text, "hello");
    }
}
