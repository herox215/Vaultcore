// TypeScript interfaces mirroring the serde(rename_all = "camelCase") structs
// produced by src-tauri/src/commands/links.rs and src-tauri/src/indexer/link_graph.rs.

/** An entry in the backlinks panel for a given target note. */
export interface BacklinkEntry {
  /** Vault-relative path of the file that contains the link. */
  sourcePath: string;
  /** Display title of the source file. */
  sourceTitle: string;
  /** Surrounding line text for context display. */
  context: string;
  /** 0-based line number of the link in the source file. */
  lineNumber: number;
}

/**
 * A single wiki-link parsed out of a Markdown document — the raw record
 * produced by the Rust indexer (mirrors `src-tauri/src/indexer/link_graph.rs::ParsedLink`).
 *
 * This is the per-occurrence form returned by `getOutgoingLinks`. It is
 * distinct from `src/lib/outgoingLinks.ts#OutgoingLink`, which is the
 * aggregated (deduplicated-by-target) shape the sidebar renders on top.
 */
export interface ParsedLink {
  /** Raw link target as written (e.g. "Note", "Folder/Note", "Note.md"). */
  targetRaw: string;
  /** Optional alias text after `|` (e.g. `[[Note|alias]]` → `"alias"`). */
  alias: string | null;
  /** 0-based line number where the link appears. */
  lineNumber: number;
  /** Full line text (used as context in backlink-style UIs). */
  context: string;
}

/** A wiki-link that could not be resolved to any file in the vault. */
export interface UnresolvedLink {
  /** Vault-relative path of the file that contains the dangling link. */
  sourcePath: string;
  /** The raw target string as written in the link. */
  targetRaw: string;
  /** 0-based line number. */
  lineNumber: number;
}

/** A single node in the link-graph payload (local or global). */
export interface GraphNode {
  /** Vault-relative path for resolved files, `unresolved:<raw>` for dangling links. */
  id: string;
  /** Display label — filename stem for resolved, link text for unresolved. */
  label: string;
  /** Vault-relative path (empty string for unresolved pseudo-nodes). */
  path: string;
  /** Number of resolved incoming links — drives node sizing. */
  backlinkCount: number;
  /** `true` when the node maps to an indexed file in the vault. */
  resolved: boolean;
  /** Tags contained in the file (lowercased, deduped, sorted). Populated only
   * by `get_link_graph`; the local-graph command leaves this empty. */
  tags?: string[];
}

/** An undirected edge between two graph nodes. */
export interface GraphEdge {
  from: string;
  to: string;
}

/** Result returned by `get_local_graph`. */
export interface LocalGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * One anchor entry returned by `get_resolved_anchors` (#62).
 *
 * `byteStart`/`byteEnd` are UTF-8 byte offsets — kept for completeness but
 * the frontend never slices by them. `jsStart`/`jsEnd` are UTF-16 code-unit
 * offsets, precomputed in Rust so JS string slicing on `noteContentCache`
 * content is correct for multi-byte content (CJK, emoji, surrogate pairs).
 */
export interface AnchorEntry {
  /** Block id (lowercased) for blocks; heading slug for headings. */
  id: string;
  byteStart: number;
  byteEnd: number;
  jsStart: number;
  jsEnd: number;
}

/** All anchors discovered in one file, returned by `get_resolved_anchors`. */
export interface AnchorKeySet {
  blocks: AnchorEntry[];
  headings: AnchorEntry[];
}

/** Result returned by update_links_after_rename. */
export interface RenameResult {
  /** Number of files that had their links rewritten. */
  updatedFiles: number;
  /** Total number of link occurrences rewritten. */
  updatedLinks: number;
  /** Vault-relative paths of files that could not be rewritten (IO errors). */
  failedFiles: string[];
  /** Vault-relative paths of files whose content was rewritten. Use to reload open tabs. */
  updatedPaths: string[];
}
