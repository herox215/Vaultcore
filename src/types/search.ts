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

/** A fuzzy filename match result with character positions for highlight. */
export interface FileMatch {
  /** Vault-relative path with forward-slash separators. */
  path: string;
  /** Nucleo composite score (sum of all atom scores). */
  score: number;
  /** Character positions in `path` that matched the query (sorted, deduplicated). */
  matchIndices: number[];
}
