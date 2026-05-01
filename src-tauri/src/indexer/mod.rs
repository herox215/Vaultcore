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
pub mod anchors;
pub mod anchor_index;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use anchor_index::AnchorIndex;
use anchors::{build_anchor_key_set, extract_anchors, AnchorKeySet};
use link_graph::{LinkGraph, ParsedLink, StemIndex, extract_links};
use tag_index::{TagIndex, extract_inline_tag_occurrences};
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

use tauri::{AppHandle, Emitter, Runtime};

// ── Read instrumentation (test-only, #179) ───────────────────────────────────
//
// Cold-start regression guard: `index_vault` must read every `.md` file AT
// MOST ONCE per invocation. Before ticket #179 the indexer did a second
// filesystem pass just to feed `LinkGraph::update_file` + `TagIndex::update_file`.
// The counter is incremented inside `read_md_file`, the single helper every
// `std::fs::read_to_string` call in `index_vault` goes through. Production
// builds compile the helper down to a plain `read_to_string` call — the
// counter and its helpers are strictly `#[cfg(test)]`.

#[cfg(test)]
pub(crate) static READ_COUNT: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn reset_read_count() {
    READ_COUNT.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn read_count() -> usize {
    READ_COUNT.load(Ordering::SeqCst)
}

/// Read a Markdown file's contents. Thin wrapper over `std::fs::read_to_string`
/// so the test-only read counter (#179) can observe every call without a
/// global `Fs` trait refactor. On failure the caller handles it the same way
/// it would handle a raw `read_to_string` error — non-UTF-8 files still
/// return `Err` here (UTF-8 validation happens inside `read_to_string`).
fn read_md_file(path: &Path) -> io::Result<String> {
    #[cfg(test)]
    READ_COUNT.fetch_add(1, Ordering::SeqCst);
    std::fs::read_to_string(path)
}

const PROGRESS_THROTTLE: Duration = Duration::from_millis(50);
const PROGRESS_EVENT: &str = "vault://index_progress";
/// T-03-02: cap the mpsc channel so a slow consumer doesn't cause unbounded
/// memory growth. Watcher events use try_send and drop on full channel.
///
/// Issue #139: raised from 1024 → 8192. A bulk operation (`git pull`,
/// `rsync`, mass rename) over a 100k-note vault can produce more than 1024
/// events in one 200ms debounce window; at 1024 those events would silently
/// drop and leave the link graph / tag index stale until a full rebuild.
/// At ~100 bytes per enqueued command this is a 100KB memory cost for the
/// queue — small compared to the Tantivy writer heap. Pairs with the
/// `try_send_or_warn` helper in watcher.rs that now logs every overflow.
pub(crate) const CHANNEL_CAPACITY: usize = 8192;
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
        /// Signaled after the writer commits and the reader reloads so the
        /// IPC caller can `.await` completion (#148 — the Search panel must
        /// re-run its query only once the fresh index is readable).
        done_tx: Option<tokio::sync::oneshot::Sender<()>>,
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
    /// In-memory anchor index (#62) — `rel_path -> AnchorTable`. Populated
    /// during cold-start and on every `UpdateLinks` so block-ref / heading-
    /// ref resolution works without an extra IPC round-trip.
    anchor_index: Arc<Mutex<AnchorIndex>>,
    /// #345: registry of locked encrypted roots. When populated, the
    /// cold-start walker prunes their subtrees so ciphertext is neither
    /// tokenized into Tantivy (garbage hits) nor traversed for links /
    /// tags (leaked structure). Defaults to an empty registry so tests
    /// and non-encryption callers behave exactly as before.
    locked_paths: Arc<crate::encryption::LockedPathRegistry>,
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
    ///
    /// Test-only convenience: creates a fresh FileIndex. Production callers go
    /// through `new_with_file_index` so the coordinator shares the state-owned
    /// `Arc<RwLock<FileIndex>>` and user-initiated rename/move updates (#277)
    /// are observable both here and in state-scoped lookups.
    pub async fn new(vault_path: &Path) -> Result<Self, VaultError> {
        Self::new_with_file_index(vault_path, Arc::new(RwLock::new(FileIndex::new()))).await
    }

    /// Like `new`, but uses `file_index` as the shared in-memory FileIndex.
    /// See the rationale in `VaultState::file_index` (#277).
    pub async fn new_with_file_index(
        vault_path: &Path,
        file_index: Arc<RwLock<FileIndex>>,
    ) -> Result<Self, VaultError> {
        // Start from a clean in-memory map on every open_vault — a previous
        // session's FileIndex may have stale entries that the upcoming
        // `index_vault` walk wouldn't otherwise evict.
        if let Ok(mut guard) = file_index.write() {
            guard.clear();
        }
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
        let matcher = Arc::new(Mutex::new(nucleo_matcher::Matcher::new(
            nucleo_matcher::Config::DEFAULT,
        )));
        let link_graph = Arc::new(Mutex::new(LinkGraph::new()));
        let tag_index = Arc::new(Mutex::new(TagIndex::new()));
        let anchor_index = Arc::new(Mutex::new(AnchorIndex::new()));

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
        let anchor_index_clone = Arc::clone(&anchor_index);
        tokio::task::spawn_blocking(move || {
            run_queue_consumer(
                writer,
                rx,
                reader_clone,
                file_index_clone,
                link_graph_clone,
                tag_index_clone,
                anchor_index_clone,
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
            anchor_index,
            locked_paths: Arc::new(crate::encryption::LockedPathRegistry::new()),
        })
    }

    /// #345: wire the shared locked-paths registry from `VaultState` into
    /// this coordinator. Called once by `open_vault` after the manifest
    /// is populated, before the first `index_vault` pass. Cheap — just
    /// replaces the default empty registry Arc with the shared one.
    pub fn set_locked_paths(&mut self, registry: Arc<crate::encryption::LockedPathRegistry>) {
        self.locked_paths = registry;
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

    /// Clone the anchor_index Arc for use in IPC commands (#62).
    pub fn anchor_index(&self) -> Arc<Mutex<AnchorIndex>> {
        Arc::clone(&self.anchor_index)
    }

    /// Index all `.md` files in `vault_path` and return a `VaultInfo`.
    ///
    /// Skips files whose SHA-256 hash has not changed (IDX-03).
    /// Non-UTF-8 files are silently skipped (IDX-08).
    /// Emits `vault://index_progress` events throttled at 50 ms.
    pub async fn index_vault<R: Runtime>(
        &self,
        vault_path: &Path,
        app: &AppHandle<R>,
    ) -> Result<VaultInfo, VaultError> {
        let vaultcore_dir = vault_path.join(".vaultcore");

        // Issue #279: self-healing bootstrap of the per-vault home canvas.
        // Runs every open so filesystem-level deletion recreates the file.
        if let Err(e) = ensure_home_canvas(vault_path) {
            log::warn!("ensure_home_canvas failed: {e:?}");
        }

        // Issue #285: bootstrap / refresh the bundled docs page. Version-
        // tagged, so unchanged app versions skip the write entirely.
        if let Err(e) = ensure_docs_page(vault_path) {
            log::warn!("ensure_docs_page failed: {e:?}");
        }

        // Collect all .md paths (skip dot-dirs, .vaultcore, and #345
        // locked encrypted subtrees — ciphertext files must not enter
        // the Tantivy index or be parsed for links/tags).
        let locked_paths = Arc::clone(&self.locked_paths);
        let md_paths: Vec<PathBuf> = walk_md_files_skipping(vault_path, move |p| {
            let canon = crate::encryption::CanonicalPath::assume_canonical(p.to_path_buf());
            locked_paths.is_locked(&canon)
        })
        .collect();
        let total = md_paths.len();

        let mut last_emit = Instant::now() - PROGRESS_THROTTLE;
        let mut file_list: Vec<String> = Vec::with_capacity(total);

        // Single-read buffers (#179). Pre-fix, a second pass re-read every
        // `.md` file just to feed the link graph + tag index — doubling cold-
        // start disk I/O on a 100k-note vault. We now extract links + tags
        // from the same `String` we already read for hashing/body/title, push
        // them into these buffers, and flush after the loop (once `file_list`
        // — the `all_paths` slice both indexes consume — is complete).
        //
        // Order-insensitive flush: `LinkGraph::update_file_with_index` and
        // `TagIndex::update_file_with_tags` each call `remove_file(rel)` as
        // their first step, so any iteration order yields the same end state.
        let mut link_buffer: Vec<(String, Vec<ParsedLink>)> = Vec::with_capacity(total);
        let mut tag_buffer: Vec<(String, Vec<String>)> = Vec::with_capacity(total);
        // Anchor buffer (#62). Holds the small wire-format payload, NOT the
        // raw file content — the latter would balloon the buffer to several
        // hundred MB on a 100k-note vault and overrun the 250 MB active-RAM
        // budget. The UTF-16 offsets are computed inline against the
        // already-borrowed `content` String, which is dropped as soon as
        // the loop body completes.
        let mut anchor_buffer: Vec<(String, AnchorKeySet)> = Vec::with_capacity(total);

        for (i, abs_path) in md_paths.iter().enumerate() {
            // Read file — skip non-UTF-8 silently (IDX-08). THE ONLY read of
            // `abs_path` inside `index_vault`; everything else reuses this
            // `String`.
            let content = match read_md_file(abs_path) {
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

            // Buffer link + tag data from this single in-memory read. Both
            // branches of `already_current` must buffer — otherwise a vault
            // where every file is hash-unchanged would lose link/tag state
            // after a coordinator restart (the `file_index` cache survives
            // across `index_vault` runs via `new_with_file_index`, but
            // `LinkGraph` / `TagIndex` are freshly constructed in
            // `IndexCoordinator::new_with_file_index` and need repopulating
            // every cold start).
            let links = extract_links(&content);
            link_buffer.push((relative_path.clone(), links));
            let tags = extract_inline_tag_occurrences(&content);
            tag_buffer.push((relative_path.clone(), tags));
            let anchor_table = extract_anchors(&content);
            let anchor_payload = build_anchor_key_set(&content, &anchor_table);
            anchor_buffer.push((relative_path.clone(), anchor_payload));

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

        // Flush the link + tag buffers. `file_list` is fully populated now,
        // so the StemIndex the link-graph consumes matches the legacy pass-2
        // input byte-for-byte. Each `update_file_with_index` / `update_file_with_tags`
        // internally calls `remove_file` first, making the flush idempotent
        // and order-insensitive.
        //
        // Perf (#250 preserved): build the vault-wide `StemIndex` once so the
        // per-file `update_file_with_index` call is O(k) in the stem bucket
        // instead of O(N) with per-path `to_lowercase` allocations.
        {
            let all_paths: Vec<String> = file_list.clone();
            let stem_index = StemIndex::build(&all_paths);

            if let Ok(mut lg) = self.link_graph.lock() {
                for (rel, links) in link_buffer {
                    lg.update_file_with_index(&rel, links, &stem_index);
                }
            }
            if let Ok(mut ti) = self.tag_index.lock() {
                for (rel, tags) in tag_buffer {
                    ti.update_file_with_tags(&rel, tags);
                }
            }
            if let Ok(mut ai) = self.anchor_index.lock() {
                for (rel, payload) in anchor_buffer {
                    ai.update_file_with_payload(&rel, payload);
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
    anchor_index: Arc<Mutex<AnchorIndex>>,
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
            IndexCmd::Rebuild { vault_path, done_tx } => {
                // Clear writer and re-walk — simplified rebuild within the task.
                if let Err(e) = writer.delete_all_documents() {
                    log::error!("Tantivy delete_all failed during rebuild: {e}");
                    if let Some(tx) = done_tx { let _ = tx.send(()); }
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
                if let Some(tx) = done_tx { let _ = tx.send(()); }
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
                // Issue #62: same content read powers anchor extraction —
                // refresh the anchor index alongside links so block-ref
                // resolution stays current after every save / external edit.
                let anchor_table = anchors::extract_anchors(&content);
                if let Ok(mut ai) = anchor_index.lock() {
                    ai.update_file(&rel_path, &content, anchor_table);
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
                // Issue #62: drop anchor entries with the deleted file.
                if let Ok(mut ai) = anchor_index.lock() {
                    ai.remove_file(&rel_path);
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

/// Walk all `.md` files under `vault_path`, skipping every dot-prefixed
/// directory (`.obsidian`, `.vaultcore`, `.trash`, `sub/.nested/…`, …).
///
/// Shared by the indexer's cold-start + rebuild paths and by the
/// user-interactive rename / count-wiki-links commands (#180).
///
/// Contract — keep the `filter_entry` *before* `filter_map(Result::ok)`:
/// that ordering is what prunes the whole dot-subtree rather than walking
/// into it and surfacing errors per entry.
pub(crate) fn walk_md_files(vault_path: &Path) -> impl Iterator<Item = PathBuf> {
    walk_md_files_skipping(vault_path, |_| false)
}

/// Same as `walk_md_files` but prunes any entry whose path passes the
/// `skip` predicate — both directories (cutting a whole subtree off) and
/// files. Used by #345 to keep the walker from descending into locked
/// encrypted roots (where the contents are ciphertext and indexing them
/// would produce garbage tokens + leak paths into backlinks and search).
///
/// The predicate runs on every directory entry before the dot-prefix
/// check, so skipped directories short-circuit their subtree.
pub(crate) fn walk_md_files_skipping<F>(
    vault_path: &Path,
    skip: F,
) -> impl Iterator<Item = PathBuf>
where
    F: Fn(&Path) -> bool + Send + Sync + 'static,
{
    walkdir::WalkDir::new(vault_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(move |e| {
            // Depth 0 is the vault root itself — always allow.
            if e.depth() == 0 {
                return true;
            }
            if skip(e.path()) {
                return false;
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
}

/// Convenience: `walk_md_files(p).collect()`. Kept for call sites that want
/// an owned `Vec` — the indexer's cold-start pass needs the total count up
/// front for progress throttling.
fn collect_md_paths(vault_path: &Path) -> Vec<PathBuf> {
    walk_md_files(vault_path).collect()
}

/// Ensure `<vault>/.vaultcore/home.canvas` exists.
///
/// Writes a minimal welcome canvas the first time a vault is opened so the
/// sidebar vault-name click always has something to open. Living under
/// `.vaultcore/` keeps it out of the tree walker, link graph, backlinks, and
/// search — but wiki-links inside it still resolve outward because resolution
/// is target-based.
///
/// Existing files are left untouched — never overwrite user edits.
/// If the user deletes the file via the filesystem, the next vault open
/// recreates this template.
pub fn ensure_home_canvas(vault_path: &Path) -> Result<(), VaultError> {
    let home_path = vault_path.join(".vaultcore").join("home.canvas");
    if home_path.exists() {
        return Ok(());
    }
    if let Some(parent) = home_path.parent() {
        std::fs::create_dir_all(parent).map_err(VaultError::Io)?;
    }

    let vault_name = vault_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Vault");
    let welcome_text = format!(
        "# {}\n\nEdit this canvas — it's your personal home.",
        vault_name
    );

    let doc = serde_json::json!({
        "nodes": [{
            "id": "welcome",
            "type": "text",
            "x": 0,
            "y": 0,
            "width": 400,
            "height": 120,
            "text": welcome_text,
        }],
        "edges": [],
    });

    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(&doc, &mut ser).map_err(|e| {
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;
    std::fs::write(&home_path, &buf).map_err(VaultError::Io)?;
    Ok(())
}

/// Storage-trait variant of `ensure_home_canvas` for backends that don't
/// surface a POSIX-mappable vault root (Android SAF). Writes the same
/// JSON template through the `VaultStorage` trait using vault-relative
/// paths, so the file lands in `<tree>/.vaultcore/home.canvas` regardless
/// of the underlying ContentProvider. Idempotent: skips when the file
/// already exists.
pub fn ensure_home_canvas_via_storage(
    storage: &dyn crate::storage::VaultStorage,
    display_name: &str,
) -> Result<(), VaultError> {
    const REL_PATH: &str = ".vaultcore/home.canvas";
    if storage.exists(REL_PATH) {
        return Ok(());
    }
    storage.create_dir(".vaultcore")?;

    let welcome_text = format!(
        "# {}\n\nEdit this canvas — it's your personal home.",
        display_name
    );
    let doc = serde_json::json!({
        "nodes": [{
            "id": "welcome",
            "type": "text",
            "x": 0,
            "y": 0,
            "width": 400,
            "height": 120,
            "text": welcome_text,
        }],
        "edges": [],
    });

    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(&doc, &mut ser).map_err(|e| {
        VaultError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;
    storage.create_file(REL_PATH, &buf)?;
    Ok(())
}

/// Storage-trait variant of `ensure_docs_page` for backends that don't
/// surface a POSIX-mappable vault root. Reads the head of the existing
/// file (when present) via the storage trait to compare the embedded
/// `vaultcore_docs_version` against the running build, and rewrites
/// only on mismatch — same semantics as the POSIX path, expressed in
/// vault-relative form.
pub fn ensure_docs_page_via_storage(
    storage: &dyn crate::storage::VaultStorage,
) -> Result<(), VaultError> {
    const REL_PATH: &str = ".vaultcore/DOCS.md";
    let current_version = env!("CARGO_PKG_VERSION");

    if storage.exists(REL_PATH) {
        if let Ok(bytes) = storage.read_file(REL_PATH) {
            let head_len = bytes.len().min(1024);
            if let Ok(head) = std::str::from_utf8(&bytes[..head_len]) {
                let needle = format!("vaultcore_docs_version: \"{}\"", current_version);
                if head.contains(&needle) {
                    return Ok(());
                }
            }
        }
    }

    storage.create_dir(".vaultcore")?;

    let header = format!(
        "---\nvaultcore_docs_version: \"{}\"\n---\n\n",
        current_version
    );
    let mut contents = String::with_capacity(header.len() + DOCS_TEMPLATE_BODY.len());
    contents.push_str(&header);
    contents.push_str(DOCS_TEMPLATE_BODY);

    if storage.exists(REL_PATH) {
        storage.write_file(REL_PATH, contents.as_bytes())?;
    } else {
        storage.create_file(REL_PATH, contents.as_bytes())?;
    }
    Ok(())
}

/// Bundled docs body. Shipped alongside the binary so the file contents
/// can be edited as normal Markdown without touching Rust code.
const DOCS_TEMPLATE_BODY: &str = include_str!("../../resources/DOCS.template.md");

/// Idempotently ensure `<vault>/.vaultcore/DOCS.md` exists and is current
/// with the running app version (#285).
///
/// The file starts with a YAML frontmatter block carrying
/// `vaultcore_docs_version: "<CARGO_PKG_VERSION>"`. On every vault open we
/// read the first few hundred bytes and compare: if the tag matches the
/// running app version the file is left alone, otherwise the whole file is
/// overwritten. This lets the docs stay fresh across upgrades without
/// clobbering the file on every launch. Users who edit the file will lose
/// their changes on the next upgrade — the header warns about this.
pub fn ensure_docs_page(vault_path: &Path) -> Result<(), VaultError> {
    let docs_path = vault_path.join(".vaultcore").join("DOCS.md");
    let current_version = env!("CARGO_PKG_VERSION");

    if docs_path.exists() && file_declares_version(&docs_path, current_version) {
        return Ok(());
    }

    if let Some(parent) = docs_path.parent() {
        std::fs::create_dir_all(parent).map_err(VaultError::Io)?;
    }

    // Front-matter stamped with the running version. The generator-warning
    // line sits inside the frontmatter as a plain `warning:` key so YAML
    // parsers on the frontend ignore it safely, but humans opening the raw
    // file still see it.
    let header = format!(
        "---\nvaultcore_docs_version: \"{}\"\n---\n\n",
        current_version
    );
    let mut contents = String::with_capacity(header.len() + DOCS_TEMPLATE_BODY.len());
    contents.push_str(&header);
    contents.push_str(DOCS_TEMPLATE_BODY);

    std::fs::write(&docs_path, contents.as_bytes()).map_err(VaultError::Io)?;
    Ok(())
}

/// Returns true when `path` exists and its YAML frontmatter declares the
/// given `vaultcore_docs_version`. Only reads the file's head (≤ 1 KB) —
/// the frontmatter block is always at the top and bounded in practice.
fn file_declares_version(path: &Path, version: &str) -> bool {
    let Ok(file) = std::fs::File::open(path) else { return false };
    use std::io::Read;
    let mut buf = [0u8; 1024];
    let mut reader = std::io::BufReader::new(file);
    let Ok(n) = reader.read(&mut buf) else { return false };
    let head = match std::str::from_utf8(&buf[..n]) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let needle = format!("vaultcore_docs_version: \"{}\"", version);
    head.contains(&needle)
}

/// Collect all `.canvas` relative paths (forward-slash, vault-relative) under
/// `vault_path`. Used by `get_resolved_links` so wiki-links like
/// `[[mycanvas]]` resolve to `.canvas` files the same way they resolve to
/// `.md` files (#147). Canvas files are not indexed by Tantivy or the
/// FileIndex — link resolution is the only thing we need them for.
pub fn collect_canvas_rel_paths(vault_path: &Path) -> Vec<String> {
    walkdir::WalkDir::new(vault_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
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
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("canvas"))
        })
        .filter_map(|e| {
            e.path()
                .strip_prefix(vault_path)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect()
}
