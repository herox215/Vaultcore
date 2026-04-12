//! Three-way merge engine for external file changes.
//! Uses the `similar` crate for line-level diffing.
//! Full implementation in Plan 05.

use similar::{Algorithm, ChangeTag, capture_diff_slices};

#[derive(Debug, PartialEq)]
pub enum MergeOutcome {
    Clean(String),
    Conflict(String),
}

pub fn three_way_merge(base: &str, left: &str, right: &str) -> MergeOutcome {
    todo!("Implemented in Plan 05")
}
