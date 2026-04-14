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

/** A wiki-link that could not be resolved to any file in the vault. */
export interface UnresolvedLink {
  /** Vault-relative path of the file that contains the dangling link. */
  sourcePath: string;
  /** The raw target string as written in the link. */
  targetRaw: string;
  /** 0-based line number. */
  lineNumber: number;
}

/** A single node in the local-graph payload returned by `get_local_graph`. */
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
