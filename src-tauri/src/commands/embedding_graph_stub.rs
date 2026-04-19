//! #235 — feature-off stub for `get_embedding_graph`.
//!
//! Mirrors the `semantic_search` pattern: when the `embeddings` feature
//! is disabled the IPC call still resolves with an empty graph, so the
//! frontend doesn't have to branch on feature availability.

use crate::commands::links::LocalGraph;
use crate::error::VaultError;

#[tauri::command]
pub async fn get_embedding_graph(
    _top_k: usize,
    _threshold: f32,
    _state: tauri::State<'_, crate::VaultState>,
) -> Result<LocalGraph, VaultError> {
    Ok(LocalGraph {
        nodes: Vec::new(),
        edges: Vec::new(),
    })
}
