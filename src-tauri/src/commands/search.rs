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

    // Gather all relative paths from the in-memory file index.
    let paths: Vec<String> = {
        let fi = file_index_arc
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;
        fi.all_relative_paths()
    };

    // Build nucleo pattern with special syntax support.
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);

    // Score and collect matches using the pre-warmed Matcher.
    let mut buf: Vec<char> = Vec::new();
    let mut matches: Vec<(String, u32, Vec<u32>)> = {
        let mut matcher = matcher_arc
            .lock()
            .map_err(|_| VaultError::IndexCorrupt)?;

        paths
            .into_iter()
            .filter_map(|path| {
                buf.clear();
                let haystack = Utf32Str::new(&path, &mut buf);
                let mut indices: Vec<u32> = Vec::new();
                let score = pattern.indices(haystack, &mut *matcher, &mut indices)?;
                // Sort + dedup per nucleo docs — multiple atoms append independently.
                indices.sort_unstable();
                indices.dedup();
                Some((path, score, indices))
            })
            .collect()
    };

    // Sort by score descending, cap at limit.
    matches.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    matches.truncate(limit);

    let results = matches
        .into_iter()
        .map(|(path, score, match_indices)| FileMatch {
            path,
            score,
            match_indices,
        })
        .collect();

    Ok(results)
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

    // Send rebuild command to the background write-queue consumer.
    // No Mutex guard is held at this await point.
    tx.send(IndexCmd::Rebuild { vault_path })
        .await
        .map_err(|_| VaultError::IndexCorrupt)?;

    // Emit "in progress" toast (rebuild completes asynchronously in the queue).
    let _ = app.emit(
        "vault://index_toast",
        serde_json::json!({
            "message": "Index wird neu aufgebaut — läuft im Hintergrund",
            "variant": "clean-merge"
        }),
    );

    Ok(())
}
