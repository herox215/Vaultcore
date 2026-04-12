//! Three-way merge engine for external file changes.
//! Uses the `similar` crate for line-level diffing (D-11, RESEARCH Pattern 3).
//!
//! Algorithm:
//! 1. Fast-path shortcuts for identical inputs.
//! 2. Compute Myers diffs from base→left and base→right.
//! 3. Extract base-line ranges touched by each branch.
//! 4. If any ranges overlap → Conflict (keep local/left).
//! 5. Otherwise → apply non-conflicting changes and return Clean.

use similar::{Algorithm, capture_diff_slices};
use serde::Serialize;

#[derive(Debug, PartialEq, Clone, Serialize)]
pub enum MergeOutcome {
    Clean(String),
    Conflict(String),
}

/// Perform a line-level three-way merge.
///
/// - `base`: the last-saved content (base snapshot for diff anchoring)
/// - `left`: current editor buffer (local edits)
/// - `right`: new disk content (external edits)
///
/// Returns:
/// - `Clean(merged)`: non-conflicting changes applied, both edits visible
/// - `Conflict(left)`: overlapping edit regions detected, local version kept
pub fn three_way_merge(base: &str, left: &str, right: &str) -> MergeOutcome {
    // Fast-path shortcuts ────────────────────────────────────────────────────

    // If left == right, both sides are the same — no merge needed
    if left == right {
        return MergeOutcome::Clean(left.to_string());
    }
    // If base == left, only the external side changed
    if base == left {
        return MergeOutcome::Clean(right.to_string());
    }
    // If base == right, only the local side changed
    if base == right {
        return MergeOutcome::Clean(left.to_string());
    }

    // Line-level diff ────────────────────────────────────────────────────────

    let base_lines: Vec<&str> = base.lines().collect();
    let left_lines: Vec<&str> = left.lines().collect();
    let right_lines: Vec<&str> = right.lines().collect();

    // Compute diffs from base to each branch using Myers algorithm
    let left_ops = capture_diff_slices(Algorithm::Myers, &base_lines, &left_lines);
    let right_ops = capture_diff_slices(Algorithm::Myers, &base_lines, &right_lines);

    // Extract the base-line index ranges modified by each branch
    let left_ranges = changed_base_ranges(&left_ops);
    let right_ranges = changed_base_ranges(&right_ops);

    // Check for overlap between any left range and any right range
    let has_conflict = left_ranges.iter().any(|lr| {
        right_ranges.iter().any(|rr| ranges_overlap(lr, rr))
    });

    if has_conflict {
        // D-11 step 4: keep local (left) version entirely
        MergeOutcome::Conflict(left.to_string())
    } else {
        // Apply right's non-conflicting changes onto the left base
        let merged = apply_non_conflicting(
            &base_lines,
            &left_lines,
            &right_lines,
            &left_ops,
            &right_ops,
            left.ends_with('\n'),
            right.ends_with('\n'),
        );
        MergeOutcome::Clean(merged)
    }
}

// ─── Helper: extract changed base-line ranges from a diff ────────────────────

/// Walk through diff operations and extract the ranges of base lines that were
/// changed (deleted or replaced) by the diff. These ranges are used for
/// conflict detection.
///
/// A "changed range" is a contiguous span of base-line indices that appear as
/// `Delete` entries in the diff (which covers both deletions and replacements,
/// since `similar` represents a replacement as Delete + Insert pairs).
///
/// Returns a Vec of `(start_inclusive, end_exclusive)` index pairs into base.
fn changed_base_ranges(ops: &[similar::DiffOp]) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();

    for op in ops {
        match op {
            similar::DiffOp::Delete { old_index, old_len, .. } => {
                if *old_len > 0 {
                    ranges.push((*old_index, old_index + old_len));
                }
            }
            similar::DiffOp::Replace { old_index, old_len, .. } => {
                if *old_len > 0 {
                    ranges.push((*old_index, old_index + old_len));
                }
            }
            similar::DiffOp::Insert { .. } | similar::DiffOp::Equal { .. } => {
                // Insertions and equal spans don't consume base lines in a
                // conflicting way (insertions are anchored between base lines)
            }
        }
    }

    ranges
}

// ─── Helper: interval overlap check ──────────────────────────────────────────

/// Standard half-open interval overlap: returns true if [a.0, a.1) and [b.0, b.1) overlap.
#[inline]
fn ranges_overlap(a: &(usize, usize), b: &(usize, usize)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

// ─── Helper: apply non-conflicting changes ────────────────────────────────────

/// Build a merged output by walking base lines and applying non-conflicting
/// changes from both branches.
///
/// Strategy:
/// - Walk through base lines in order using both sets of diff ops.
/// - For each position:
///   - If right changed it (but left didn't): use right's replacement.
///   - If left changed it (but right didn't): use left's replacement.
///   - If neither changed: use base.
/// - Handle insertions (lines added without removing base lines) at their
///   anchored positions.
///
/// Since we've already verified there are no overlapping ranges, we can
/// process the right diff ops linearly and overlay onto the left content.
fn apply_non_conflicting(
    base_lines: &[&str],
    left_lines: &[&str],
    right_lines: &[&str],
    left_ops: &[similar::DiffOp],
    right_ops: &[similar::DiffOp],
    left_trailing_newline: bool,
    right_trailing_newline: bool,
) -> String {
    // Build a representation of the left result first (already a clean state).
    // Then overlay the right changes onto it, adjusting for line-number shifts
    // caused by the left edits.

    // We compute the merged result by replaying base→right changes, but
    // replacing unmodified base lines with the corresponding left lines.
    //
    // Approach: iterate right_ops; for each op:
    //   - Equal: emit the corresponding left content (which may have been
    //     already modified by left ops, so look up from left_lines using
    //     the left-side mapping)
    //   - Insert (right only): emit the right insertion
    //   - Delete/Replace (right only): emit right's new content (replacing
    //     the corresponding base lines, which left had not changed)

    // First, build a mapping from base-line index → left-line content.
    // For base lines that were not changed by left: they appear in left_lines
    // (possibly at a different index due to left's insertions/deletions).
    // For base lines that were changed by left: use the left replacement lines.
    //
    // Simplification: walk left_ops to build a Vec<Vec<&str>> indexed by base pos.
    // Each entry is the lines that should appear in place of that base line
    // in the left output (empty vec = line deleted, one+ entries = replacement/keep).

    let base_len = base_lines.len();
    // left_replacement[i] = lines that replace base line i in the left output
    let mut left_replacement: Vec<Vec<&str>> = vec![Vec::new(); base_len + 1]; // +1 for trailing insertions
    // left_insert_before[i] = lines inserted before base line i by left
    let mut left_insert_before: Vec<Vec<&str>> = vec![Vec::new(); base_len + 1];

    for op in left_ops {
        match op {
            similar::DiffOp::Equal { old_index, new_index, len, .. } => {
                for j in 0..*len {
                    left_replacement[old_index + j] = vec![left_lines[new_index + j]];
                }
            }
            similar::DiffOp::Delete { old_index, old_len, .. } => {
                for j in 0..*old_len {
                    left_replacement[old_index + j] = vec![]; // deleted
                }
            }
            similar::DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                // All new_len new lines replace the old_len base lines.
                // Assign the new lines to the first old base position;
                // mark remaining old positions as deleted.
                for j in 0..*old_len {
                    if j == 0 {
                        let new_content: Vec<&str> = left_lines[*new_index..*new_index + new_len].to_vec();
                        left_replacement[old_index + j] = new_content;
                    } else {
                        left_replacement[old_index + j] = vec![];
                    }
                }
            }
            similar::DiffOp::Insert { old_index, new_index, new_len } => {
                // Lines inserted before old_index in the left output
                let inserted: Vec<&str> = left_lines[*new_index..*new_index + new_len].to_vec();
                left_insert_before[*old_index].extend(inserted);
            }
        }
    }

    // Now walk right_ops and build the merged output.
    // For base lines untouched by right: emit what left produced.
    // For base lines changed by right: emit right's content (left didn't touch them).
    // For right-only insertions: emit right's inserted lines.

    let mut result_lines: Vec<&str> = Vec::new();

    for op in right_ops {
        match op {
            similar::DiffOp::Equal { old_index, new_index, len, .. } => {
                // These base lines were not changed by right.
                // Emit what left produced for them.
                for j in 0..*len {
                    let base_i = old_index + j;
                    // Any left insertions before this base line
                    result_lines.extend_from_slice(&left_insert_before[base_i]);
                    // Left's replacement for this base line
                    result_lines.extend_from_slice(&left_replacement[base_i]);
                    // Note: the right "equal" line from right_lines[new_index+j] is
                    // the same as base_lines[base_i] so we use left's version.
                    let _ = new_index; // suppress unused warning
                }
            }
            similar::DiffOp::Insert { old_index, new_index, new_len } => {
                // Lines inserted by right at this position.
                // Also emit any left insertions anchored at the same base point first.
                result_lines.extend_from_slice(&left_insert_before[*old_index]);
                let inserted: Vec<&str> = right_lines[*new_index..*new_index + new_len].to_vec();
                result_lines.extend(inserted);
                let _ = old_index; // suppress unused warning
            }
            similar::DiffOp::Delete { old_index, old_len, .. } => {
                // Right deleted these base lines. Since left didn't touch them
                // (verified by conflict check), we honor the right deletion.
                // Skip left's content for these lines.
                for j in 0..*old_len {
                    let base_i = old_index + j;
                    // Still emit left insertions anchored before these lines
                    // (they're anchored to the position, not the deleted content)
                    result_lines.extend_from_slice(&left_insert_before[base_i]);
                    // The base line itself is deleted — emit nothing from left_replacement
                }
            }
            similar::DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                // Right replaced these base lines with new content.
                // Emit any left insertions anchored at the first deleted base line.
                result_lines.extend_from_slice(&left_insert_before[*old_index]);
                // Then emit right's new content
                let new_content: Vec<&str> = right_lines[*new_index..*new_index + new_len].to_vec();
                result_lines.extend(new_content);
                // Skip left's content for the replaced base lines
                for j in 1..*old_len {
                    let base_i = old_index + j;
                    // Insertions anchored to later-deleted lines — emit before the replaced block
                    result_lines.extend_from_slice(&left_insert_before[base_i]);
                }
            }
        }
    }

    // Emit any trailing left insertions anchored after all base lines
    result_lines.extend_from_slice(&left_insert_before[base_len]);

    // Preserve trailing newline: if either left or right ends with '\n', add one.
    let trailing_newline = left_trailing_newline || right_trailing_newline;

    let mut merged = result_lines.join("\n");
    if trailing_newline && !merged.is_empty() && !merged.ends_with('\n') {
        merged.push('\n');
    }

    merged
}
