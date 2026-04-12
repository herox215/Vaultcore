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
