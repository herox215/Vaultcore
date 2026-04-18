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
pub mod frontmatter;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use link_graph::{LinkGraph, extract_links};
use tag_index::TagIndex;
use frontmatter::parse_frontmatter;

use tantivy::directory::error::LockError;
use tantivy::schema::Schema;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyError, Term};
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
    /// Drop every document from the index without re-walking the vault.
    /// Used on vault open to evict orphan entries whose on-disk files were
    /// removed between sessions; `index_vault` immediately re-populates.
    DeleteAll,
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
    /// Issue #137: RwLock instead of Mutex so concurrent searches
    /// (search_filename, link autocomplete, tag panel, backlinks) don't
    /// serialise behind the rare watcher writes. Bench at 100k entries
    /// showed p95 read-completion time drop from 1.48 s (Mutex) to 130 ms
    /// (RwLock) under 16 concurrent readers + 1 churning writer; numbers
    /// reproducible via tests::file_index_contention (--ignored).
    file_index: Arc<RwLock<FileIndex>>,
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
    ///
    /// The Tantivy `IndexWriter` is acquired *eagerly* (with retry) before the
    /// task is spawned. This is what surfaces `IndexLocked` / `IndexCorrupt`
    /// errors back to the caller instead of letting the writer task die
    /// silently after `new` already returned `Ok` (issue #108).
    pub async fn new(vault_path: &Path) -> Result<Self, VaultError> {
        let (schema, path_field, title_field, body_field) = tantivy_index::build_schema();

        let vaultcore_dir = vault_path.join(".vaultcore");
        let index_dir = vaultcore_dir.join("index").join("tantivy");

        // Schema-version check must happen BEFORE the index is opened and
        // before the background writer task is spawned.  If we wipe the
        // directory after the task is live, index.writer() races with
        // remove_dir_all() and fails with LockFailure / NotFound.
        if !tantivy_index::check_version(&vaultcore_dir)
            && index_dir.exists() {
                std::fs::remove_dir_all(&index_dir).map_err(VaultError::Io)?;
                log::info!("Schema mismatch — index directory wiped for rebuild");
            }

        let index = tantivy_index::open_or_create_index(&index_dir, &schema)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|_| VaultError::IndexCorrupt)?;

        // Acquire the writer here so a `LockBusy` failure (issue #108) is
        // visible to `open_vault` — and to the user — instead of being
        // logged once and then silently swallowed by an exiting task.
        let writer = acquire_writer_with_retry(&index).await?;

        let index = Arc::new(index);
        let reader = Arc::new(reader);
        let file_index = Arc::new(RwLock::new(FileIndex::new()));
        let matcher = Arc::new(Mutex::new(nucleo_matcher::Matcher::new(
            nucleo_matcher::Config::DEFAULT,
        )));
        let link_graph = Arc::new(Mutex::new(LinkGraph::new()));
        let tag_index = Arc::new(Mutex::new(TagIndex::new()));

        let (tx, rx) = mpsc::channel::<IndexCmd>(CHANNEL_CAPACITY);

        // Spawn the single writer task on the blocking thread pool (#138).
        // Tantivy's IndexWriter ops (add_document, commit, delete_term,
        // delete_all_documents) are synchronous and can run for hundreds of
        // milliseconds on a large vault. If the consumer ran on the async
        // runtime, every other future sharing the executor (progress events,
        // vault status, IPC polling) would stall during a bulk commit. Moving
        // the loop onto `spawn_blocking` keeps the Tantivy call-chain off
        // the async executor entirely. Senders still use
        // `tokio::sync::mpsc::Sender::{send,try_send}` untouched; the
        // consumer drains via `Receiver::blocking_recv()`, which is
        // explicitly designed for this bridging pattern.
        let reader_clone = Arc::clone(&reader);
        let file_index_clone = Arc::clone(&file_index);
        let link_graph_clone = Arc::clone(&link_graph);
        let tag_index_clone = Arc::clone(&tag_index);
        tokio::task::spawn_blocking(move || {
            run_queue_consumer(
                writer,
                rx,
                reader_clone,
                file_index_clone,
                link_graph_clone,
                tag_index_clone,
                schema,
                path_field,
                title_field,
                body_field,
            );
        });

        // Evict orphans left over from prior sessions (issue #46). Runs on the
        // NEW writer's channel so it cannot race a previous coordinator's
        // still-draining writer task. `index_vault`'s AddFile commands land
        // after this in the queue, repopulating the index immediately.
        let _ = tx.try_send(IndexCmd::DeleteAll);

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

    pub fn file_index(&self) -> Arc<RwLock<FileIndex>> {
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
                let guard = self.file_index.read().map_err(|_| VaultError::LockPoisoned)?;
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
                // Issue #60: parse frontmatter once per add so aliases land
                // in FileMeta at the same time the file enters the index.
                let aliases = parse_frontmatter(&content).aliases;

                // Update in-memory index before sending to queue.
                {
                    let mut guard = self.file_index.write().map_err(|_| VaultError::LockPoisoned)?;
                    guard.insert(
                        abs_path.clone(),
                        FileMeta {
                            relative_path: relative_path.clone(),
                            hash: hash.clone(),
                            title: title.clone(),
                            aliases,
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
fn run_queue_consumer(
    mut writer: IndexWriter,
    mut rx: mpsc::Receiver<IndexCmd>,
    reader: Arc<IndexReader>,
    file_index: Arc<RwLock<FileIndex>>,
    link_graph: Arc<Mutex<LinkGraph>>,
    tag_index: Arc<Mutex<TagIndex>>,
    _schema: Schema,
    path_field: tantivy::schema::Field,
    title_field: tantivy::schema::Field,
    body_field: tantivy::schema::Field,
) {
    // Runs on the blocking thread pool (see IndexCoordinator::new). Uses
    // `blocking_recv()` so the Tantivy write chain never touches the async
    // executor (#138).
    while let Some(cmd) = rx.blocking_recv() {
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
            IndexCmd::DeleteAll => {
                if let Err(e) = writer.delete_all_documents() {
                    log::error!("Tantivy delete_all failed: {e}");
                    continue;
                }
                if let Err(e) = writer.commit() {
                    log::error!("Tantivy delete_all commit failed: {e}");
                } else if let Err(e) = reader.reload() {
                    log::error!("Tantivy delete_all reader reload failed: {e}");
                }
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
                        .read()
                        .map(|fi| fi.all_relative_paths())
                        .unwrap_or_default()
                };
                let links = extract_links(&content);
                if let Ok(mut lg) = link_graph.lock() {
                    lg.update_file(&rel_path, links, &all_paths);
                }
                // Issue #60: keep FileMeta.aliases in sync on every file edit.
                // UpdateLinks fires after every save/rename/external modify, so
                // piggy-backing alias refresh here avoids introducing another
                // command channel for a single metadata slot.
                let aliases = parse_frontmatter(&content).aliases;
                if let Ok(mut fi) = file_index.write() {
                    fi.set_aliases_for_rel(&rel_path, aliases);
                }
            }
            IndexCmd::RemoveLinks { rel_path } => {
                // Remove link-graph entries for a deleted file (LINK-08).
                if let Ok(mut lg) = link_graph.lock() {
                    lg.remove_file(&rel_path);
                }
                // Issue #60: aliases hang off FileMeta; when DeleteFile drops the
                // FileIndex entry the aliases die with it, so nothing extra to
                // clear here. RemoveLinks fires on rename-old too — the rename's
                // new-side UpdateLinks command repopulates aliases under the new
                // rel_path.
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

// ── Writer acquisition with retry ────────────────────────────────────────────

/// Backoff schedule for `acquire_writer_with_retry`. Total ≈ 1.55 s — long
/// enough to outlast the previous coordinator's `Drop`-then-Shutdown drain on
/// vault re-open, short enough that a real "another instance is running"
/// failure surfaces to the user quickly.
const ACQUIRE_BACKOFF_MS: &[u64] = &[50, 100, 200, 400, 800];

/// Try to acquire the Tantivy `IndexWriter`, retrying on transient
/// `LockBusy` failures.
///
/// On `LockBusy` after the full backoff is exhausted, returns
/// `VaultError::IndexLocked` so `open_vault` can show a dedicated toast
/// instead of degrading silently. Any other Tantivy error maps to
/// `VaultError::IndexCorrupt`, matching the existing rebuild-recovery flow.
async fn acquire_writer_with_retry(index: &Index) -> Result<IndexWriter, VaultError> {
    let total = ACQUIRE_BACKOFF_MS.len() + 1;
    for attempt in 0..total {
        match index.writer(WRITER_HEAP_BYTES) {
            Ok(w) => {
                if attempt > 0 {
                    log::info!("IndexWriter acquired on retry {attempt}");
                }
                return Ok(w);
            }
            Err(TantivyError::LockFailure(LockError::LockBusy, _)) => {
                if let Some(&delay) = ACQUIRE_BACKOFF_MS.get(attempt) {
                    log::warn!(
                        "IndexWriter LockBusy (attempt {attempt}), retrying in {delay}ms"
                    );
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                } else {
                    log::error!("IndexWriter LockBusy after {total} attempts — giving up");
                    return Err(VaultError::IndexLocked);
                }
            }
            Err(e) => {
                log::error!("Failed to create IndexWriter: {e}");
                return Err(VaultError::IndexCorrupt);
            }
        }
    }
    unreachable!("loop body always either returns or sleeps before exiting");
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
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .map(|e| e.into_path())
        .collect()
}
