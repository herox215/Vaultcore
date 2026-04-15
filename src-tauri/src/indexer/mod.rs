// Indexer module — Tantivy full-text search pipeline for VaultCore.
//
// Architecture:
// - `tantivy_index` — schema, index open/create, version sidecar helpers
// - `memory`        — in-memory FileIndex with SHA-256 hash cache (IDX-03)
// - `parser`        — Markdown → plain text via pulldown-cmark (T-03-01)
// - `mod`           — IndexCoordinator: single mpsc write queue (T-03-02)
//
// All Tantivy writes are serialised through the mpsc channel so there is never
// more than one concurrent writer (design decision from spec §17).
//
// Note: the submodule is named `tantivy_index` (not `tantivy`) to avoid
// shadowing the external `tantivy` crate — which would make `tantivy::doc!`
// and other crate items inaccessible.

pub mod tantivy_index;
pub mod memory;
pub mod parser;
pub mod link_graph;
pub mod tag_index;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use link_graph::{LinkGraph, extract_links};
use tag_index::TagIndex;

use tantivy::schema::Schema;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};
use tokio::sync::mpsc;

use crate::error::VaultError;
use crate::hash::hash_bytes;
use crate::commands::vault::VaultInfo;
use memory::{FileIndex, FileMeta};

/// Payload for vault://index_progress events (mirrors the private struct in vault.rs).
#[derive(serde::Serialize, Clone, Debug)]
pub struct IndexProgressPayload {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

use tauri::{AppHandle, Emitter};

const PROGRESS_THROTTLE: Duration = Duration::from_millis(50);
const PROGRESS_EVENT: &str = "vault://index_progress";
/// T-03-02: cap the mpsc channel so a slow consumer doesn't cause unbounded
/// memory growth. Watcher events use try_send and drop on full channel.
const CHANNEL_CAPACITY: usize = 1024;
/// IndexWriter heap budget per Tantivy recommendation for moderate workloads.
const WRITER_HEAP_BYTES: usize = 50_000_000;

// ── Commands sent to the queue consumer task ─────────────────────────────────

pub enum IndexCmd {
    AddFile {
        path: PathBuf,
        title: String,
        body: String,
        hash: String,
    },
    DeleteFile {
        path: PathBuf,
    },
    Commit,
    Rebuild {
        vault_path: PathBuf,
    },
    Shutdown,
    /// Incrementally update link-graph entries for a file (LINK-08).
    UpdateLinks {
        rel_path: String,
        content: String,
    },
    /// Remove all link-graph entries for a deleted file (LINK-08).
    RemoveLinks {
        rel_path: String,
    },
    /// Incrementally update tag-index entries for a file (TAG-01/02).
    UpdateTags {
        rel_path: String,
        content: String,
    },
    /// Remove all tag-index entries for a deleted file (TAG-01/02).
    RemoveTags {
        rel_path: String,
    },
}

// ── IndexCoordinator ──────────────────────────────────────────────────────────

/// Central coordinator for all Tantivy index operations.
///
/// Owns the mpsc sender end.  The single background task owns the
/// `IndexWriter` — guaranteeing no concurrent writes.
pub struct IndexCoordinator {
    /// Channel sender — search commands use this to enqueue rebuild requests.
    pub tx: mpsc::Sender<IndexCmd>,
    file_index: Arc<Mutex<FileIndex>>,
    matcher: Arc<Mutex<nucleo_matcher::Matcher>>,
    /// Shared reader — search commands clone this Arc to query the index.
    pub reader: Arc<IndexReader>,
    /// Shared index handle — search commands need it to build queries.
    pub index: Arc<Index>,
    /// In-memory link adjacency list — shared with link IPC commands.
    link_graph: Arc<Mutex<LinkGraph>>,
    /// In-memory tag index — shared with tag IPC commands.
    tag_index: Arc<Mutex<TagIndex>>,
}

impl Drop for IndexCoordinator {
    /// Shut the background writer task down cleanly when the coordinator is
    /// dropped (e.g. on vault switch). Without this, the stale task would
    /// keep its Tantivy `IndexWriter` — and therefore the directory write
    /// lock on the previous vault's `.vaultcore/index/tantivy` — alive until
    /// the channel closed naturally, racing the new coordinator that is
    /// about to open a writer on the new vault.
    ///
    /// Best-effort: `try_send` on a closed or full channel is ignored. The
    /// task also terminates on channel close when the sender drops, so even
    /// if the Shutdown command is lost the writer still releases promptly.
    fn drop(&mut self) {
        let _ = self.tx.try_send(IndexCmd::Shutdown);
    }
}

impl IndexCoordinator {
    /// Create a new coordinator and spawn the background write-queue consumer.
    pub fn new(vault_path: &Path) -> Result<Self, VaultError> {
        let (schema, path_field, title_field, body_field) = tantivy_index::build_schema();

        let vaultcore_dir = vault_path.join(".vaultcore");
        let index_dir = vaultcore_dir.join("index").join("tantivy");

        // Schema-version check must happen BEFORE the index is opened and
        // before the background writer task is spawned.  If we wipe the
        // directory after the task is live, index.writer() races with
        // remove_dir_all() and fails with LockFailure / NotFound.
        if !tantivy_index::check_version(&vaultcore_dir) {
            if index_dir.exists() {
                std::fs::remove_dir_all(&index_dir).map_err(VaultError::Io)?;
                log::info!("Schema mismatch — index directory wiped for rebuild");
            }
        }

        let index = tantivy_index::open_or_create_index(&index_dir, &schema)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|_| VaultError::IndexCorrupt)?;

        let index = Arc::new(index);
        let reader = Arc::new(reader);
        let file_index = Arc::new(Mutex::new(FileIndex::new()));
        let matcher = Arc::new(Mutex::new(nucleo_matcher::Matcher::new(
            nucleo_matcher::Config::DEFAULT,
        )));
        let link_graph = Arc::new(Mutex::new(LinkGraph::new()));
        let tag_index = Arc::new(Mutex::new(TagIndex::new()));

        let (tx, rx) = mpsc::channel::<IndexCmd>(CHANNEL_CAPACITY);

        // Spawn the single writer task.
        let index_clone = Arc::clone(&index);
        let reader_clone = Arc::clone(&reader);
        let file_index_clone = Arc::clone(&file_index);
        let link_graph_clone = Arc::clone(&link_graph);
        let tag_index_clone = Arc::clone(&tag_index);
        tokio::spawn(async move {
            run_queue_consumer(
                rx,
                index_clone,
                reader_clone,
                file_index_clone,
                link_graph_clone,
                tag_index_clone,
                schema,
                path_field,
                title_field,
                body_field,
            )
            .await;
        });

        Ok(Self {
            tx,
            file_index,
            matcher,
            reader,
            index,
            link_graph,
            tag_index,
        })
    }

    pub fn file_index(&self) -> Arc<Mutex<FileIndex>> {
        Arc::clone(&self.file_index)
    }

    pub fn matcher(&self) -> Arc<Mutex<nucleo_matcher::Matcher>> {
        Arc::clone(&self.matcher)
    }

    /// Clone the link_graph Arc for use in IPC commands.
    pub fn link_graph(&self) -> Arc<Mutex<LinkGraph>> {
        Arc::clone(&self.link_graph)
    }

    /// Clone the tag_index Arc for use in IPC commands.
    pub fn tag_index(&self) -> Arc<Mutex<TagIndex>> {
        Arc::clone(&self.tag_index)
    }

    /// Index all `.md` files in `vault_path` and return a `VaultInfo`.
    ///
    /// Skips files whose SHA-256 hash has not changed (IDX-03).
    /// Non-UTF-8 files are silently skipped (IDX-08).
    /// Emits `vault://index_progress` events throttled at 50 ms.
    pub async fn index_vault(
        &self,
        vault_path: &Path,
        app: &AppHandle,
    ) -> Result<VaultInfo, VaultError> {
        let vaultcore_dir = vault_path.join(".vaultcore");

        // Collect all .md paths (skip dot-dirs and .vaultcore).
        let md_paths = collect_md_paths(vault_path);
        let total = md_paths.len();

        let mut last_emit = Instant::now() - PROGRESS_THROTTLE;
        let mut file_list: Vec<String> = Vec::with_capacity(total);

        for (i, abs_path) in md_paths.iter().enumerate() {
            // Read file — skip non-UTF-8 silently (IDX-08).
            let content = match std::fs::read_to_string(abs_path) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let hash = hash_bytes(content.as_bytes());

            // Incremental skip: if hash unchanged, still add to file_list but
            // don't re-index (IDX-03).
            let already_current = {
                let guard = self.file_index.lock().map_err(|_| VaultError::Io(
                    std::io::Error::new(std::io::ErrorKind::Other, "file_index lock poisoned"),
                ))?;
                guard.get(abs_path).map(|m| m.hash == hash).unwrap_or(false)
            };

            let stem = abs_path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();

            let relative_path = abs_path
                .strip_prefix(vault_path)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();

            file_list.push(relative_path.clone());

            if !already_current {
                let body = parser::strip_markdown(&content);
                let title = tantivy_index::extract_title(&content, &stem);

                // Update in-memory index before sending to queue.
                {
                    let mut guard = self.file_index.lock().map_err(|_| VaultError::Io(
                        std::io::Error::new(std::io::ErrorKind::Other, "file_index lock poisoned"),
                    ))?;
                    guard.insert(
                        abs_path.clone(),
                        FileMeta {
                            relative_path: relative_path.clone(),
                            hash: hash.clone(),
                            title: title.clone(),
                        },
                    );
                }

                let _ = self
                    .tx
                    .send(IndexCmd::AddFile {
                        path: abs_path.clone(),
                        title,
                        body,
                        hash,
                    })
                    .await;
            }

            // Throttled progress events.
            let current = i + 1;
            let should_emit = current == total || last_emit.elapsed() >= PROGRESS_THROTTLE;
            if should_emit {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    IndexProgressPayload {
                        current,
                        total,
                        current_file: relative_path,
                    },
                );
                last_emit = Instant::now();
            }
        }

        // Commit and write version sidecar.
        let _ = self.tx.send(IndexCmd::Commit).await;
        tantivy_index::write_version(&vaultcore_dir)?;

        // Populate the link graph from all indexed files.
        // Two-pass: file_list already contains all relative paths; now
        // re-read each file and update the graph.  We hold the link_graph
        // lock only briefly per file.
        {
            let all_paths: Vec<String> = file_list.clone();
            for abs_path in md_paths.iter() {
                let rel = abs_path
                    .strip_prefix(vault_path)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if let Ok(content) = std::fs::read_to_string(abs_path) {
                    let links = extract_links(&content);
                    if let Ok(mut lg) = self.link_graph.lock() {
                        lg.update_file(&rel, links, &all_paths);
                    }
                    if let Ok(mut ti) = self.tag_index.lock() {
                        ti.update_file(&rel, &content);
                    }
                }
            }
        }

        file_list.sort();

        Ok(VaultInfo {
            path: vault_path.to_string_lossy().into_owned(),
            file_count: file_list.len(),
            file_list,
        })
    }
}

// ── Queue consumer task ───────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn run_queue_consumer(
    mut rx: mpsc::Receiver<IndexCmd>,
    index: Arc<Index>,
    reader: Arc<IndexReader>,
    file_index: Arc<Mutex<FileIndex>>,
    link_graph: Arc<Mutex<LinkGraph>>,
    tag_index: Arc<Mutex<TagIndex>>,
    _schema: Schema,
    path_field: tantivy::schema::Field,
    title_field: tantivy::schema::Field,
    body_field: tantivy::schema::Field,
) {
    let mut writer: IndexWriter = match index.writer(WRITER_HEAP_BYTES) {
        Ok(w) => w,
        Err(e) => {
            log::error!("Failed to create IndexWriter: {e}");
            return;
        }
    };

    while let Some(cmd) = rx.recv().await {
        match cmd {
            IndexCmd::AddFile { path, title, body, .. } => {
                let path_str = path.to_string_lossy().into_owned();
                // Delete any existing document for this path first (upsert pattern).
                writer.delete_term(Term::from_field_text(path_field, &path_str));
                let document = doc!(
                    path_field => path_str,
                    title_field => title,
                    body_field => body,
                );
                if let Err(e) = writer.add_document(document) {
                    log::error!("Tantivy add_document failed: {e}");
                }
            }
            IndexCmd::DeleteFile { path } => {
                let path_str = path.to_string_lossy().into_owned();
                writer.delete_term(Term::from_field_text(path_field, &path_str));
            }
            IndexCmd::Commit => {
                if let Err(e) = writer.commit() {
                    log::error!("Tantivy commit failed: {e}");
                } else if let Err(e) = reader.reload() {
                    log::error!("Tantivy reader reload failed: {e}");
                }
            }
            IndexCmd::Rebuild { vault_path } => {
                // Clear writer and re-walk — simplified rebuild within the task.
                if let Err(e) = writer.delete_all_documents() {
                    log::error!("Tantivy delete_all failed during rebuild: {e}");
                    continue;
                }
                let paths = collect_md_paths(&vault_path);
                for abs_path in paths {
                    let content = match std::fs::read_to_string(&abs_path) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    let stem = abs_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let path_str = abs_path.to_string_lossy().into_owned();
                    let title = tantivy_index::extract_title(&content, &stem);
                    let body = parser::strip_markdown(&content);
                    let document = doc!(
                        path_field => path_str,
                        title_field => title,
                        body_field => body,
                    );
                    if let Err(e) = writer.add_document(document) {
                        log::error!("Tantivy rebuild add_document failed: {e}");
                    }
                }
                if let Err(e) = writer.commit() {
                    log::error!("Tantivy rebuild commit failed: {e}");
                } else if let Err(e) = reader.reload() {
                    log::error!("Tantivy rebuild reader reload failed: {e}");
                }
            }
            IndexCmd::UpdateLinks { rel_path, content } => {
                // Incremental link-graph update (LINK-08).
                let all_paths = {
                    file_index
                        .lock()
                        .map(|fi| fi.all_relative_paths())
                        .unwrap_or_default()
                };
                let links = extract_links(&content);
                if let Ok(mut lg) = link_graph.lock() {
                    lg.update_file(&rel_path, links, &all_paths);
                }
            }
            IndexCmd::RemoveLinks { rel_path } => {
                // Remove link-graph entries for a deleted file (LINK-08).
                if let Ok(mut lg) = link_graph.lock() {
                    lg.remove_file(&rel_path);
                }
            }
            IndexCmd::UpdateTags { rel_path, content } => {
                // Incrementally update tag-index entries for a file (TAG-01/02).
                if let Ok(mut ti) = tag_index.lock() {
                    ti.update_file(&rel_path, &content);
                }
            }
            IndexCmd::RemoveTags { rel_path } => {
                // Remove tag-index entries for a deleted file (TAG-01/02).
                if let Ok(mut ti) = tag_index.lock() {
                    ti.remove_file(&rel_path);
                }
            }
            IndexCmd::Shutdown => {
                if let Err(e) = writer.commit() {
                    log::error!("Tantivy shutdown commit failed: {e}");
                }
                break;
            }
        }
    }
    // `writer` drops here, releasing the write lock on the index directory.
    log::info!("IndexCoordinator write queue shut down");
}

// ── Walk helper ───────────────────────────────────────────────────────────────

/// Collect all `.md` paths under `vault_path`, skipping dot-directories
/// (including `.obsidian`, `.vaultcore`, `.trash`).
fn collect_md_paths(vault_path: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(vault_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Depth 0 is the vault root itself — always allow.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_str().unwrap_or("");
            !name.starts_with('.')
        })
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .map_or(false, |ext| ext.eq_ignore_ascii_case("md"))
        })
        .map(|e| e.into_path())
        .collect()
}
