//! Tests for the three-way merge engine (merge.rs, Plan 05).
//! These tests correspond to the 8 behaviors specified in the PLAN.

use crate::merge::{three_way_merge, MergeOutcome};

// ─── Test 1: External-only change applied cleanly ─────────────────────────────
/// When only the right (external) side changed from base, the result is
/// MergeOutcome::Clean(right). The local editor is still at base content.
#[test]
fn test_external_only_change() {
    let base = "line1\nline2\nline3";
    let left = base; // local = base, no edits
    let right = "line1\nline2 modified by external\nline3";

    let result = three_way_merge(base, left, right);
    assert_eq!(result, MergeOutcome::Clean(right.to_string()));
}

// ─── Test 2: Local-only change ─────────────────────────────────────────────────
/// When only the left (local editor) side changed, merge returns Clean(left).
/// The external disk content is still at base.
#[test]
fn test_local_only_change() {
    let base = "line1\nline2\nline3";
    let left = "line1\nline2 edited locally\nline3";
    let right = base; // external = base, no external change

    let result = three_way_merge(base, left, right);
    assert_eq!(result, MergeOutcome::Clean(left.to_string()));
}

// ─── Test 3: Non-overlapping changes merged cleanly ───────────────────────────
/// When left changed one region and right changed a different region,
/// the result includes both changes (Clean merge).
#[test]
fn test_non_overlapping_changes_merged() {
    let base = "alpha\nbeta\ngamma\ndelta";
    // Left changes first line
    let left = "alpha modified\nbeta\ngamma\ndelta";
    // Right changes last line
    let right = "alpha\nbeta\ngamma\ndelta modified";

    let result = three_way_merge(base, left, right);
    match result {
        MergeOutcome::Clean(merged) => {
            assert!(merged.contains("alpha modified"), "merged should contain left's edit");
            assert!(merged.contains("delta modified"), "merged should contain right's edit");
            assert!(merged.contains("beta"), "unmodified lines should remain");
            assert!(merged.contains("gamma"), "unmodified lines should remain");
        }
        MergeOutcome::Conflict(_) => panic!("Expected Clean merge for non-overlapping changes"),
    }
}

// ─── Test 4: Same-line conflict → Conflict(left) ─────────────────────────────
/// When both left and right changed the same line, local (left) is kept.
#[test]
fn test_same_line_conflict_keeps_local() {
    let base = "line1\nline2\nline3";
    let left = "line1\nline2 local edit\nline3";
    let right = "line1\nline2 external edit\nline3";

    let result = three_way_merge(base, left, right);
    assert_eq!(result, MergeOutcome::Conflict(left.to_string()));
}

// ─── Test 5: All identical → Clean(base) ─────────────────────────────────────
/// When base, left, and right are all the same, no merge needed — Clean(base).
#[test]
fn test_all_identical_returns_clean_base() {
    let base = "unchanged content\nstill unchanged";
    let result = three_way_merge(base, base, base);
    assert_eq!(result, MergeOutcome::Clean(base.to_string()));
}

// ─── Test 6: Empty base and left → Clean(right) ──────────────────────────────
/// When base and left are both empty (new file scenario), external content wins.
#[test]
fn test_empty_base_and_left_returns_right() {
    let base = "";
    let left = "";
    let right = "new content added externally";

    let result = three_way_merge(base, left, right);
    assert_eq!(result, MergeOutcome::Clean(right.to_string()));
}

// ─── Test 7: Adjacent (non-overlapping) changes → Clean merge ─────────────────
/// Changes to adjacent lines (not the exact same line) should merge cleanly.
/// Left modifies line 2; right modifies line 3 (adjacent but distinct).
#[test]
fn test_adjacent_non_overlapping_changes_merge() {
    let base = "line1\nline2\nline3\nline4";
    let left = "line1\nline2-local\nline3\nline4";
    let right = "line1\nline2\nline3-external\nline4";

    let result = three_way_merge(base, left, right);
    match result {
        MergeOutcome::Clean(merged) => {
            assert!(merged.contains("line2-local"), "left's adjacent edit should be in merge");
            assert!(merged.contains("line3-external"), "right's adjacent edit should be in merge");
        }
        MergeOutcome::Conflict(_) => panic!("Expected Clean merge for adjacent non-overlapping changes"),
    }
}

// ─── Test 8: Multi-line overlapping → Conflict(left) ─────────────────────────
/// When both sides modified a multi-line block that overlaps, the full local
/// version (left) is kept.
#[test]
fn test_multiline_overlap_conflict_keeps_local() {
    let base = "intro\nblock-line1\nblock-line2\nblock-line3\noutro";
    // Left modifies the entire block
    let left = "intro\nlocal-block-A\nlocal-block-B\nlocal-block-C\noutro";
    // Right also modifies some of the same block
    let right = "intro\nexternal-block-A\nexternal-block-B\nblock-line3\noutro";

    let result = three_way_merge(base, left, right);
    assert_eq!(result, MergeOutcome::Conflict(left.to_string()));
}
