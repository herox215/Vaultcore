// Frontend mirror of the Rust `DirEntry` struct (src-tauri/src/commands/tree.rs).
// Any change here must stay in lock-step with the Rust struct definition.

export interface DirEntry {
  name: string;
  path: string;       // Absolute path (canonicalized by Rust backend)
  is_dir: boolean;
  is_symlink: boolean;
  is_md: boolean;     // true for .md extension
}
