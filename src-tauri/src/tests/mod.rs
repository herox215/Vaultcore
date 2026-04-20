mod error_serialize;
mod files;
mod files_ops;
mod vault_stats;
mod tree;
mod watcher;
mod merge;
mod indexer;
mod link_graph;
mod local_graph;
mod global_graph;
pub mod tag_index;
mod hash_verify;
mod bookmarks;
mod aliases;
mod snippets;
mod file_index_contention;
mod vault_walk;
mod rename_link_resolution;
#[cfg(feature = "embeddings")]
mod embeddings;
#[cfg(feature = "embeddings")]
mod semantic_quality;
#[cfg(feature = "embeddings")]
mod embedding_graph;
#[cfg(feature = "embeddings")]
mod embedding_release;
