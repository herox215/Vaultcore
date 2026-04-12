/** Mirror of Rust `TagUsage` — used by Plan 07 tag panel. */
export interface TagUsage {
  tag: string;
  count: number;
}

/** Mirror of Rust `TagOccurrence`. camelCase via serde rename_all on the Rust side. */
export interface TagOccurrence {
  sourceRelPath: string;
  lineNumber: number;
}
