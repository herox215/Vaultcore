// TypeScript interfaces mirroring the serde(rename_all = "camelCase") structs
// produced by src-tauri/src/commands/search.rs.

/** A ranked full-text search result with an HTML snippet. */
export interface SearchResult {
  /** Absolute path to the file. */
  path: string;
  /** First `# ` heading or filename stem. */
  title: string;
  /** Tantivy BM25 score. */
  score: number;
  /** HTML string with `<b>highlighted</b>` terms from SnippetGenerator. */
  snippet: string;
  /** Number of highlighted term ranges in the snippet. */
  matchCount: number;
}

/** Semantic-search hit from the HNSW vector index (#202).
 *  Path + chunkIndex identify the span; `score` is cosine similarity in
 *  `[-1, 1]` (typically `[0, 1]` for English prose) — higher = more similar. */
export interface SemanticHit {
  path: string;
  chunkIndex: number;
  score: number;
}

/** Hybrid (BM25 + HNSW) search hit fused via Reciprocal Rank Fusion (#203).
 *  `score` is the fused RRF score (sum of `1 / (60 + rank_i)` per source).
 *  Per-source `*Rank` and `*Score` fields are present only for the source(s)
 *  that surfaced the hit — both populated means it ranked in both indices. */
export interface HybridHit {
  path: string;
  title: string;
  score: number;
  /** HTML with `<b>highlighted</b>` BM25 terms; empty for vec-only hits with
   *  no BM25 doc found. */
  snippet: string;
  matchCount: number;
  bm25Rank?: number;
  bm25Score?: number;
  vecRank?: number;
  vecScore?: number;
}

/** A fuzzy filename match result with character positions for highlight. */
export interface FileMatch {
  /** Vault-relative path with forward-slash separators. */
  path: string;
  /** Nucleo composite score (sum of all atom scores). */
  score: number;
  /** Character positions in `path` that matched the query (sorted, deduplicated). */
  matchIndices: number[];
  /** Frontmatter alias that scored this match (issue #60). Present only when
   *  the nucleo hit came from the alias haystack — the popup should render
   *  `matchedAlias → filename` to explain why the row surfaced. Absent (or
   *  `undefined`) for regular filename hits. */
  matchedAlias?: string;
}
