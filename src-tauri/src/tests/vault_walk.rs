// Tests for the unified `walk_md_files` helper (#180).
//
// Validates the dot-prefix subtree-pruning contract: once a directory name
// starts with `.`, neither it nor any of its descendants may surface —
// relying on `filter_entry` ordered BEFORE `filter_map(Result::ok)`.
// Case-insensitive `.md` extension filter is likewise asserted.

use std::collections::HashSet;
use std::fs;

use tempfile::tempdir;

use crate::indexer::walk_md_files;

#[test]
fn walk_md_files_skips_dot_dirs_and_is_case_insensitive() {
    let dir = tempdir().expect("tempdir");
    let vault = dir.path();

    // Expected to surface:
    fs::write(vault.join("top.md"), "").unwrap();
    fs::write(vault.join("SUB.MD"), "").unwrap(); // case-insensitive extension
    fs::create_dir_all(vault.join("subdir")).unwrap();
    fs::write(vault.join("subdir/inner.md"), "").unwrap();

    // Must NOT surface — dot-prefixed subtree must be pruned whole.
    fs::create_dir_all(vault.join(".obsidian/cache")).unwrap();
    fs::write(vault.join(".obsidian/cache/x.md"), "").unwrap();
    fs::create_dir_all(vault.join("sub/.nested")).unwrap();
    fs::write(vault.join("sub/.nested/deep.md"), "").unwrap();

    // Must NOT surface — wrong extension.
    fs::write(vault.join("readme.txt"), "").unwrap();
    fs::write(vault.join("no_ext_file"), "").unwrap();

    let found: HashSet<String> = walk_md_files(vault)
        .map(|p| {
            p.strip_prefix(vault)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();

    let expected: HashSet<String> =
        ["top.md", "SUB.MD", "subdir/inner.md"].iter().map(|s| s.to_string()).collect();

    assert_eq!(found, expected, "walk_md_files mismatch");
}
