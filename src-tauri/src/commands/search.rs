// Search commands — three Tauri commands that expose the Tantivy full-text
// index and nucleo filename matcher to the frontend.
//
// Security (T-03-06): `parse_query_lenient` never throws on malformed input;
// Tantivy's QueryParser handles escaping internally.
//
// Security (T-03-07): snippet HTML contains only `<b>` tags from
// SnippetGenerator; the body field was stripped of HTML in parser.rs.
//
// Security (T-03-08): results are capped at `limit` (default 100 for fulltext,
// 20 for filename) per D-08.

use serde::Serialize;

use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::document::Value;
use tantivy::snippet::SnippetGenerator;
use tantivy::TantivyDocument;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::Utf32Str;

use crate::error::VaultError;
use crate::VaultState;

// ── Result types ──────────────────────────────────────────────────────────────

/// A ranked full-text search result with a snippet.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Absolute path to the file.
    pub path: String,
    /// First `# ` heading or filename stem.
    pub title: String,
    /// Tantivy BM25 score.
    pub score: f32,
    /// HTML snippet with `<b>highlighted</b>` terms.
    pub snippet: String,
    /// Number of highlighted term ranges in the snippet.
    pub match_count: usize,
}

/// A fuzzy filename match result with character indices for highlight.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    /// Vault-relative path with forward-slash separators.
    pub path: String,
    /// Nucleo composite score (sum of all atom scores).
    pub score: u32,
    /// Character positions in `path` that matched the query (sorted, deduplicated).
    pub match_indices: Vec<u32>,
    /// Matched alias text (from frontmatter `aliases:`) when the nucleo hit
    /// came from an alias haystack rather than the filename. `None` for
    /// path-based matches. Issue #60: the Quick Switcher and `[[` popup
    /// render this as `alias → filename` so the user sees why the row
    /// surfaced. `default` makes older callers (search_filename) continue to
    /// serialize a `matchedAlias: null` field, which the TS types tolerate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_alias: Option<String>,
}

// ── search_fulltext ───────────────────────────────────────────────────────────

/// Full-text search over the Tantivy index.
///
/// Supports AND, OR, NOT, quoted phrases via Tantivy's lenient query parser.
/// Never returns an error for bad query syntax (D-03 live-typing contract).
///
/// # Errors
/// Returns `VaultError::IndexCorrupt` if the index is unreadable.
#[tauri::command]
pub async fn search_fulltext(
    query: String,
    limit: usize,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<SearchResult>, VaultError> {
    // If the query is empty, return nothing immediately.
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Extract index + reader handles from the coordinator while holding the
    // Mutex as briefly as possible (avoid holding it across the search call).
    let (index, reader) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;

        match guard.as_ref() {
            Some(c) => (c.index.clone(), c.reader.clone()),
            None => return Ok(Vec::new()),
        }
    };

    // Retrieve schema fields.
    let schema = index.schema();
    let path_field = schema.get_field("path").map_err(|_| VaultError::IndexCorrupt)?;
    let title_field = schema.get_field("title").map_err(|_| VaultError::IndexCorrupt)?;
    let body_field = schema.get_field("body").map_err(|_| VaultError::IndexCorrupt)?;

    // Build query — lenient parse never fails; errors are debug-logged.
    let mut query_parser = QueryParser::for_index(&index, vec![title_field, body_field]);
    query_parser.set_conjunction_by_default();
    let (parsed_query, parse_errors) = query_parser.parse_query_lenient(&query);
    if !parse_errors.is_empty() {
        log::debug!(
            "search_fulltext parse warnings for {:?}: {:?}",
            query,
            parse_errors
        );
    }

    // Search — TopDocs requires .order_by_score() to implement Collector.
    let searcher = reader.searcher();
    let top_docs: Vec<(f32, tantivy::DocAddress)> = searcher
        .search(&parsed_query, &TopDocs::with_limit(limit).order_by_score())
        .map_err(|_| VaultError::IndexCorrupt)?;

    // Snippet generator — body field, 200 chars max.
    let mut snippet_gen =
        SnippetGenerator::create(&searcher, &*parsed_query, body_field)
            .map_err(|_| VaultError::IndexCorrupt)?;
    snippet_gen.set_max_num_chars(200);

    // Collect results.
    let mut results = Vec::with_capacity(top_docs.len());
    for (score, doc_address) in top_docs {
        let doc = searcher
            .doc::<TantivyDocument>(doc_address)
            .map_err(|_| VaultError::IndexCorrupt)?;

        let path = doc
            .get_first(path_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let title = doc
            .get_first(title_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let snippet = snippet_gen.snippet_from_doc(&doc);
        let match_count = snippet.highlighted().len();
        let snippet_html = snippet.to_html();

        results.push(SearchResult {
            path,
            title,
            score,
            snippet: snippet_html,
            match_count,
        });
    }

    Ok(results)
}

// ── search_filename ───────────────────────────────────────────────────────────

/// Fuzzy filename search using the pre-warmed nucleo Matcher.
///
/// Candidate set: filenames AND frontmatter aliases (issue #60). Alias hits
/// carry the matched alias text in `matched_alias` so Quick Switcher rows
/// render as `alias → filename`. Per-path dedupe keeps the best row per
/// file; filename hits win at equal score so ranking is consistent with
/// pre-alias behaviour.
///
/// Results are sorted by composite score descending and capped at `limit`.
#[tauri::command]
pub async fn search_filename(
    query: String,
    limit: usize,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<FileMatch>, VaultError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Extract file_index and matcher Arcs while the coordinator lock is held,
    // then release it before doing the matching (avoid holding the lock over
    // potentially slow matching work).
    let (file_index_arc, matcher_arc) = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;

        match guard.as_ref() {
            Some(c) => (c.file_index(), c.matcher()),
            None => return Ok(Vec::new()),
        }
    };

    // Gather paths + per-file aliases in a single lock hold.
    let (paths, file_aliases): (Vec<String>, Vec<(String, Vec<String>)>) = {
        let fi = file_index_arc
            .read()
            .map_err(|_| VaultError::IndexCorrupt)?;
        let paths = fi.all_relative_paths();
        let aliases: Vec<(String, Vec<String>)> = fi
            .all_entries()
            .map(|(_, m)| (m.relative_path.clone(), m.aliases.clone()))
            .filter(|(_, a)| !a.is_empty())
            .collect();
        (paths, aliases)
    };

    // Build nucleo pattern with special syntax support.
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);

    // Score filenames + aliases.
    let mut buf: Vec<char> = Vec::new();
    let mut matches: Vec<FileMatch> = {
        let mut matcher = matcher_arc
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;

        let mut out: Vec<FileMatch> = paths
            .iter()
            .filter_map(|path| {
                buf.clear();
                let haystack = Utf32Str::new(path, &mut buf);
                let mut indices: Vec<u32> = Vec::new();
                let score = pattern.indices(haystack, &mut matcher, &mut indices)?;
                // Sort + dedup per nucleo docs — multiple atoms append independently.
                indices.sort_unstable();
                indices.dedup();
                Some(FileMatch {
                    path: path.clone(),
                    score,
                    match_indices: indices,
                    matched_alias: None,
                })
            })
            .collect();

        for (rel_path, aliases) in &file_aliases {
            for alias in aliases {
                buf.clear();
                let haystack = Utf32Str::new(alias, &mut buf);
                let mut indices: Vec<u32> = Vec::new();
                if let Some(score) = pattern.indices(haystack, &mut matcher, &mut indices) {
                    out.push(FileMatch {
                        path: rel_path.clone(),
                        score,
                        match_indices: Vec::new(),
                        matched_alias: Some(alias.clone()),
                    });
                }
            }
        }

        out
    };

    // Sort by score desc; at equal score, filename hits beat alias hits.
    matches.sort_unstable_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| {
            match (&a.matched_alias, &b.matched_alias) {
                (None, Some(_)) => std::cmp::Ordering::Less,
                (Some(_), None) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            }
        })
    });

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    matches.retain(|m| seen.insert(m.path.clone()));
    matches.truncate(limit);

    Ok(matches)
}

// ── semantic_search ───────────────────────────────────────────────────────────

/// Semantic (vector) search over the HNSW index (#202).
///
/// Returns up to `k` nearest chunks to `query` as `SemanticHit`s sorted
/// by descending similarity. Feature-gated: when the `embeddings` crate
/// feature is disabled, the bundled model is missing, or the coordinator
/// failed to initialise, the command returns an empty list rather than
/// erroring — matches the tolerant contract of the existing full-text
/// commands.
///
/// `k` is clamped to `[1, 100]` at the boundary to bound worst-case query
/// cost; the HNSW overshoot for tombstone filtering (#200) scales with `k`.
///
/// The embed + ANN search is wrapped in `spawn_blocking` so it does not
/// stall the tokio runtime thread — a typical MiniLM embed is ~15 ms,
/// which would block other async IPC traffic otherwise.
#[cfg(feature = "embeddings")]
#[tauri::command]
pub async fn semantic_search(
    query: String,
    k: usize,
    state: tauri::State<'_, crate::VaultState>,
) -> Result<Vec<crate::embeddings::SemanticHit>, VaultError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let k = k.clamp(1, 100);

    let handles = {
        let guard = state
            .query_handles
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        match guard.as_ref() {
            Some(h) => std::sync::Arc::clone(h),
            None => return Ok(Vec::new()),
        }
    };

    tokio::task::spawn_blocking(move || {
        crate::embeddings::semantic_search_query(&handles, &query, k)
    })
    .await
    .map_err(|_| VaultError::IndexCorrupt)?
    .map_err(|e| {
        log::warn!("semantic_search failed: {e}");
        VaultError::IndexCorrupt
    })
}

/// Stub command exposed when the `embeddings` feature is off so the
/// frontend IPC call always resolves. Returns an empty list.
#[cfg(not(feature = "embeddings"))]
#[tauri::command]
pub async fn semantic_search(
    _query: String,
    _k: usize,
    _state: tauri::State<'_, crate::VaultState>,
) -> Result<Vec<serde_json::Value>, VaultError> {
    Ok(Vec::new())
}

// ── hybrid_search ─────────────────────────────────────────────────────────────

/// Per-source visibility for one fused hit. `None` on either side means
/// the path was not in that source's top-N result list — the row was
/// surfaced by the other source alone. Skipped from JSON when None so
/// the wire shape stays clean for single-source hits.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HybridHit {
    pub path: String,
    pub title: String,
    /// Fused RRF score (sum of `1 / (k + rank_i)` per source).
    pub score: f32,
    /// HTML snippet with `<b>highlighted</b>` BM25 terms; empty when
    /// the path was vec-only and the title-only fallback fired.
    pub snippet: String,
    pub match_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bm25_rank: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bm25_score: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vec_rank: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vec_score: Option<f32>,
}

/// Hybrid search (#203): fuses BM25 (Tantivy) + HNSW (vector) ranks via
/// Reciprocal Rank Fusion (k=60). Both sides run on the blocking pool
/// in parallel via `tokio::join!`, so the embed (~15 ms) overlaps with
/// the BM25 traversal.
///
/// `k` is clamped to `[1, 100]`. Each source is over-fetched to
/// `max(k * 5, 50)` capped at 200, per Cormack 2009 + downstream
/// production tuning — recall plateaus around 50.
///
/// Snippets: BM25-side hits keep their native highlighted snippet.
/// Vec-only hits get a snippet by re-running `SnippetGenerator` against
/// a `TermQuery(path:<path>)` lookup in the same searcher. Falls back
/// to filename-only title with empty snippet when the doc is missing
/// (race during initial indexing).
#[cfg(feature = "embeddings")]
#[tauri::command]
pub async fn hybrid_search(
    query: String,
    k: usize,
    state: tauri::State<'_, crate::VaultState>,
) -> Result<Vec<HybridHit>, VaultError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let k = k.clamp(1, 100);
    let top_n = k.saturating_mul(5).clamp(50, 200);

    // Extract Tantivy + embedding handles up front so the spawn_blocking
    // closures own `Send + 'static` data — matches the existing pattern
    // in search_fulltext (lock, clone Arcs, drop guard before work).
    let bm25_handles = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        guard.as_ref().map(|c| (c.index.clone(), c.reader.clone()))
    };
    let query_handles = {
        let guard = state
            .query_handles
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        guard.as_ref().map(std::sync::Arc::clone)
    };

    // BM25 side returns top_n (path, score). Cheap to spawn even when
    // the coordinator hasn't booted — empty result, no work.
    let bm25_query = query.clone();
    let bm25_task = tokio::task::spawn_blocking(move || -> Result<Vec<(String, f32)>, VaultError> {
        let Some((index, reader)) = bm25_handles.as_ref() else {
            return Ok(Vec::new());
        };
        run_bm25_top_n(index, reader, &bm25_query, top_n)
    });

    let vec_query = query.clone();
    let vec_task = tokio::task::spawn_blocking(move || -> Result<Vec<(String, f32)>, VaultError> {
        let Some(h) = query_handles.as_ref() else {
            return Ok(Vec::new());
        };
        let hits = crate::embeddings::semantic_search_query(h, &vec_query, top_n)
            .map_err(|e| {
                log::warn!("hybrid_search vec leg failed: {e}");
                VaultError::IndexCorrupt
            })?;
        Ok(hits
            .into_iter()
            .map(|h| (h.path, h.score))
            .collect())
    });

    let (bm25_res, vec_res) = tokio::join!(bm25_task, vec_task);
    let bm25 = bm25_res.map_err(|_| VaultError::IndexCorrupt)??;
    let vec_hits = vec_res.map_err(|_| VaultError::IndexCorrupt)??;

    let fused = crate::embeddings::rrf_fuse(&bm25, &vec_hits, crate::embeddings::RRF_K);
    let fused = fused.into_iter().take(k).collect::<Vec<_>>();

    if fused.is_empty() {
        return Ok(Vec::new());
    }

    // Hydrate snippets + titles. We need a Tantivy searcher again — if
    // the BM25 leg saw `None` (no coordinator) the fused result can only
    // contain vec-only hits, so skip hydration and fall back to
    // filename-only titles.
    let bm25_handles2 = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        guard.as_ref().map(|c| (c.index.clone(), c.reader.clone()))
    };
    let hydrated = tokio::task::spawn_blocking(move || -> Result<Vec<HybridHit>, VaultError> {
        hydrate_hits(bm25_handles2.as_ref(), &query, fused)
    })
    .await
    .map_err(|_| VaultError::IndexCorrupt)??;

    Ok(hydrated)
}

#[cfg(feature = "embeddings")]
fn run_bm25_top_n(
    index: &std::sync::Arc<tantivy::Index>,
    reader: &std::sync::Arc<tantivy::IndexReader>,
    query: &str,
    top_n: usize,
) -> Result<Vec<(String, f32)>, VaultError> {
    let schema = index.schema();
    let path_field = schema.get_field("path").map_err(|_| VaultError::IndexCorrupt)?;
    let title_field = schema.get_field("title").map_err(|_| VaultError::IndexCorrupt)?;
    let body_field = schema.get_field("body").map_err(|_| VaultError::IndexCorrupt)?;

    let mut qp = QueryParser::for_index(index, vec![title_field, body_field]);
    qp.set_conjunction_by_default();
    let (parsed, _errors) = qp.parse_query_lenient(query);

    let searcher = reader.searcher();
    let docs = searcher
        .search(&parsed, &TopDocs::with_limit(top_n).order_by_score())
        .map_err(|_| VaultError::IndexCorrupt)?;

    let mut out = Vec::with_capacity(docs.len());
    for (score, addr) in docs {
        let doc = searcher
            .doc::<TantivyDocument>(addr)
            .map_err(|_| VaultError::IndexCorrupt)?;
        let path = doc
            .get_first(path_field)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !path.is_empty() {
            out.push((path, score));
        }
    }
    Ok(out)
}

#[cfg(feature = "embeddings")]
fn hydrate_hits(
    bm25_handles: Option<&(std::sync::Arc<tantivy::Index>, std::sync::Arc<tantivy::IndexReader>)>,
    query: &str,
    fused: Vec<crate::embeddings::FusedHit>,
) -> Result<Vec<HybridHit>, VaultError> {
    use tantivy::query::TermQuery;
    use tantivy::schema::IndexRecordOption;
    use tantivy::Term;

    let Some((index, reader)) = bm25_handles else {
        // No Tantivy index → vec-only hits with filename-derived titles.
        return Ok(fused
            .into_iter()
            .map(|h| HybridHit {
                title: filename_title(&h.path),
                path: h.path,
                score: h.score,
                snippet: String::new(),
                match_count: 0,
                bm25_rank: h.bm25_rank,
                bm25_score: h.bm25_score,
                vec_rank: h.vec_rank,
                vec_score: h.vec_score,
            })
            .collect());
    };

    let schema = index.schema();
    let path_field = schema.get_field("path").map_err(|_| VaultError::IndexCorrupt)?;
    let title_field = schema.get_field("title").map_err(|_| VaultError::IndexCorrupt)?;
    let body_field = schema.get_field("body").map_err(|_| VaultError::IndexCorrupt)?;

    let mut qp = QueryParser::for_index(index, vec![title_field, body_field]);
    qp.set_conjunction_by_default();
    let (parsed, _errors) = qp.parse_query_lenient(query);

    let searcher = reader.searcher();
    let mut snippet_gen = SnippetGenerator::create(&searcher, &*parsed, body_field)
        .map_err(|_| VaultError::IndexCorrupt)?;
    snippet_gen.set_max_num_chars(200);

    let mut out = Vec::with_capacity(fused.len());
    for hit in fused {
        // Look up the doc by exact path. Path field is stored as STRING
        // (untokenised) so a TermQuery exact-matches.
        let term = Term::from_field_text(path_field, &hit.path);
        let term_q = TermQuery::new(term, IndexRecordOption::Basic);
        let lookup: Vec<(f32, tantivy::DocAddress)> = searcher
            .search(&term_q, &TopDocs::with_limit(1).order_by_score())
            .map_err(|_| VaultError::IndexCorrupt)?;

        let (title, snippet, match_count) = if let Some((_score, addr)) = lookup.first() {
            let doc = searcher
                .doc::<TantivyDocument>(*addr)
                .map_err(|_| VaultError::IndexCorrupt)?;
            let title = doc
                .get_first(title_field)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let snip = snippet_gen.snippet_from_doc(&doc);
            let mc = snip.highlighted().len();
            (title, snip.to_html(), mc)
        } else {
            (filename_title(&hit.path), String::new(), 0)
        };

        out.push(HybridHit {
            path: hit.path,
            title,
            score: hit.score,
            snippet,
            match_count,
            bm25_rank: hit.bm25_rank,
            bm25_score: hit.bm25_score,
            vec_rank: hit.vec_rank,
            vec_score: hit.vec_score,
        });
    }
    Ok(out)
}

#[cfg(feature = "embeddings")]
fn filename_title(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

/// Stub for builds without `embeddings` — returns an empty list so the
/// frontend IPC call always resolves to a valid array.
#[cfg(not(feature = "embeddings"))]
#[tauri::command]
pub async fn hybrid_search(
    _query: String,
    _k: usize,
    _state: tauri::State<'_, crate::VaultState>,
) -> Result<Vec<serde_json::Value>, VaultError> {
    Ok(Vec::new())
}

// ── rebuild_index ─────────────────────────────────────────────────────────────

/// Trigger a full index rebuild.
///
/// Sends `IndexCmd::Rebuild` to the queue consumer (which clears and re-indexes
/// all files). Emits toast notifications before and after dispatching the command.
///
/// The actual rebuild runs in the background write-queue task — this command
/// returns as soon as the Rebuild message is enqueued.
#[tauri::command]
pub async fn rebuild_index(
    state: tauri::State<'_, VaultState>,
    app: tauri::AppHandle,
) -> Result<(), VaultError> {
    use tauri::Emitter;
    use crate::indexer::IndexCmd;

    // Get vault path — clone so the Mutex is released before the await.
    let vault_path = {
        let vp = state
            .current_vault
            .lock()
            .map_err(|_| VaultError::VaultUnavailable { path: String::new() })?;
        match vp.as_ref() {
            Some(p) => p.clone(),
            None => {
                return Err(VaultError::VaultUnavailable {
                    path: String::from("(none)"),
                })
            }
        }
    };

    // Clone the mpsc Sender out of the coordinator so we can await without
    // holding the Mutex across the await point (Mutex guard is not Send).
    let tx = {
        let guard = state
            .index_coordinator
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;

        match guard.as_ref() {
            Some(c) => c.tx.clone(),
            None => {
                return Err(VaultError::VaultUnavailable {
                    path: vault_path.to_string_lossy().into_owned(),
                })
            }
        }
    };

    // Emit "rebuilding" toast before dispatching.
    let _ = app.emit(
        "vault://index_toast",
        serde_json::json!({
            "message": "Index wird neu aufgebaut...",
            "variant": "clean-merge"
        }),
    );

    // #148: block until the writer commits and the reader reloads. Without
    // this, the frontend kicks off a refetch against the *stale* reader and
    // newly-indexed files don't appear in the results list.
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

    // Send rebuild command to the background write-queue consumer.
    // No Mutex guard is held at this await point.
    tx.send(IndexCmd::Rebuild {
        vault_path,
        done_tx: Some(done_tx),
    })
    .await
    .map_err(|_| VaultError::IndexCorrupt)?;

    // Wait for the consumer to signal reload. A dropped sender (consumer
    // exited) surfaces as IndexCorrupt — same treatment as a send failure.
    done_rx.await.map_err(|_| VaultError::IndexCorrupt)?;

    Ok(())
}
