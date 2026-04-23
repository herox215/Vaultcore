// Typed IPC layer — the ONLY place in the frontend that imports `invoke`.
// Components and stores MUST go through these wrappers so:
//   1. Every Tauri error surfaces as a normalized `VaultError` (T-02-02).
//   2. The T-02 vault-scope guard on the Rust side cannot be bypassed by a
//      component calling `invoke` directly with an arbitrary path (T-02-01).

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { VaultError } from "../types/errors";
import { isVaultError } from "../types/errors";
import type { VaultInfo, VaultStats, RecentVault } from "../types/vault";
import type { DirEntry } from "../types/tree";
import type { SearchResult, FileMatch, SemanticHit, HybridHit } from "../types/search";
import type { BacklinkEntry, ParsedLink, UnresolvedLink, RenameResult, LocalGraph } from "../types/links";
import type { TagUsage, TagOccurrence } from "../types/tags";

function normalizeError(err: unknown): VaultError {
  if (isVaultError(err)) {
    // Guarantee `data` is `string | null`, never `undefined`, so downstream
    // discriminated-union matching never hits an unreachable branch.
    return { kind: err.kind, message: err.message, data: err.data ?? null };
  }
  return {
    kind: "Io",
    message: typeof err === "string" ? err : String(err),
    data: null,
  };
}

/** VAULT-01: native folder dialog. Returns `null` when the user cancels. */
export async function pickVaultFolder(): Promise<string | null> {
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: "Open vault",
  });
  if (picked === null) return null;
  if (Array.isArray(picked)) return picked[0] ?? null;
  return picked;
}

export async function openVault(path: string): Promise<VaultInfo> {
  try {
    return await invoke<VaultInfo>("open_vault", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function getRecentVaults(): Promise<RecentVault[]> {
  try {
    return await invoke<RecentVault[]>("get_recent_vaults");
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function repairVaultIndex(vaultPath: string): Promise<void> {
  try {
    await invoke<void>("repair_vault_index", { vaultPath });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function getVaultStats(path: string): Promise<VaultStats> {
  try {
    return await invoke<VaultStats>("get_vault_stats", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function readFile(path: string): Promise<string> {
  try {
    return await invoke<string>("read_file", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function writeFile(path: string, content: string): Promise<string> {
  try {
    return await invoke<string>("write_file", { path, content });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * EDIT-10: Read a file's current SHA-256 hex from disk. Used by auto-save
 * to detect external modifications between writes and route through the
 * three-way merge engine on mismatch.
 */
export async function getFileHash(path: string): Promise<string> {
  try {
    return await invoke<string>("get_file_hash", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function listDirectory(path: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("list_directory", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function createFile(parent: string, name: string): Promise<string> {
  try {
    return await invoke<string>("create_file", { parent, name });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function renameFile(oldPath: string, newName: string): Promise<{ newPath: string; linkCount: number }> {
  try {
    return await invoke<{ newPath: string; linkCount: number }>("rename_file", { oldPath, newName });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function deleteFile(path: string): Promise<void> {
  try {
    await invoke<void>("delete_file", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function moveFile(from: string, toFolder: string): Promise<string> {
  try {
    return await invoke<string>("move_file", { from, toFolder });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function createFolder(parent: string, name: string): Promise<string> {
  try {
    return await invoke<string>("create_folder", { parent, name });
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function countWikiLinks(filename: string): Promise<number> {
  try {
    return await invoke<number>("count_wiki_links", { filename });
  } catch (e) {
    throw normalizeError(e);
  }
}

export interface MergeResult {
  outcome: "clean" | "conflict";
  merged_content: string;
  /**
   * SHA-256 hex of the merged bytes the backend wrote to disk. Populated
   * on "clean" only — on "conflict" the backend does NOT write, so the
   * caller keeps the existing editor content and `new_hash` is null
   * (issue #339).
   */
  new_hash: string | null;
}

/**
 * SYNC-06/07: Perform a three-way merge for an external file change.
 * base = lastSavedContent, left = editorContent, right = current disk content.
 *
 * Issue #339: on "clean" the backend writes the merged bytes to disk
 * itself and returns `new_hash` — the caller must NOT re-write via
 * `writeFile`. Doing so would double-dispatch index updates and risk
 * feedback loops with the watcher.
 */
export async function mergeExternalChange(
  path: string,
  editorContent: string,
  lastSavedContent: string,
): Promise<MergeResult> {
  try {
    return await invoke<MergeResult>("merge_external_change", {
      path,
      editorContent,
      lastSavedContent,
    });
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Search commands ────────────────────────────────────────────────────────────

/**
 * Full-text search using Tantivy BM25 with AND/OR/NOT/phrase support.
 * Never throws on bad query syntax — the Rust side uses parse_query_lenient.
 */
export async function searchFulltext(
  query: string,
  limit: number = 100,
): Promise<SearchResult[]> {
  try {
    return await invoke<SearchResult[]>("search_fulltext", { query, limit });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Fuzzy filename search using the pre-warmed nucleo Matcher.
 * Returns up to `limit` matches sorted by score descending, with match
 * indices for frontend highlighting.
 */
export async function searchFilename(
  query: string,
  limit: number = 20,
): Promise<FileMatch[]> {
  try {
    return await invoke<FileMatch[]>("search_filename", { query, limit });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Semantic (vector) search over the HNSW index (#202).
 * Returns up to `k` nearest chunks to `query` by cosine similarity.
 * `k` is clamped to [1, 100] on the Rust side. Returns an empty list
 * when embeddings are disabled or the model is not bundled.
 */
export async function semanticSearch(
  query: string,
  k: number = 10,
): Promise<SemanticHit[]> {
  try {
    return await invoke<SemanticHit[]>("semantic_search", { query, k });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Hybrid search (#203): fuses BM25 (Tantivy) and HNSW (vector) ranks via
 * Reciprocal Rank Fusion (k=60). Both legs run in parallel on the Rust
 * blocking pool. `k` is clamped to [1, 100]. Falls back to BM25-only when
 * embeddings are disabled / not bundled, and to vec-only when the BM25
 * index is unavailable.
 */
export async function hybridSearch(
  query: string,
  k: number = 10,
): Promise<HybridHit[]> {
  try {
    return await invoke<HybridHit[]>("hybrid_search", { query, k });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Trigger a full index rebuild.
 * The rebuild runs asynchronously in the Rust write-queue — this call returns
 * as soon as the command is enqueued (toast notifications are emitted by Rust).
 */
export async function rebuildIndex(): Promise<void> {
  try {
    await invoke<void>("rebuild_index");
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Link commands ──────────────────────────────────────────────────────────────

/**
 * Return all backlinks for a vault-relative target path.
 */
export async function getBacklinks(path: string): Promise<BacklinkEntry[]> {
  try {
    return await invoke<BacklinkEntry[]>("get_backlinks", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Return all outgoing wiki-links from a vault-relative source path — one
 * `ParsedLink` per occurrence (duplicates preserved; deduplication, if any,
 * is the caller's job).
 */
export async function getOutgoingLinks(path: string): Promise<ParsedLink[]> {
  try {
    return await invoke<ParsedLink[]>("get_outgoing_links", { path });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Return all wiki-links across the vault that could not be resolved.
 */
export async function getUnresolvedLinks(): Promise<UnresolvedLink[]> {
  try {
    return await invoke<UnresolvedLink[]>("get_unresolved_links");
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Fuzzy filename search for `[[` autocomplete.
 * Reuses the nucleo Matcher from the Quick Switcher (Phase 3).
 */
export async function suggestLinks(
  query: string,
  limit: number = 20,
): Promise<FileMatch[]> {
  try {
    return await invoke<FileMatch[]>("suggest_links", { query, limit });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Rewrite all wiki-links in the vault that point to `oldPath` after a rename.
 * `oldPath` and `newPath` are vault-relative.
 */
export async function updateLinksAfterRename(
  oldPath: string,
  newPath: string,
): Promise<RenameResult> {
  try {
    return await invoke<RenameResult>("update_links_after_rename", {
      oldPath,
      newPath,
    });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Return a stem → vault-relative-path map for all files in the vault.
 * The frontend converts this to `Map<string, string>` for zero-IPC click handling.
 */
export async function getResolvedLinks(): Promise<Map<string, string>> {
  try {
    const record = await invoke<Record<string, string>>("get_resolved_links");
    return new Map(Object.entries(record));
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Return a lowercased `filename.ext` → vault-relative path map for every image
 * attachment in the vault. Drives the `![[image.png]]` wiki-embed resolver
 * with zero IPC per render.
 */
/**
 * Return the local link graph around `path` — BFS in both directions for
 * `depth` hops. Unresolved wiki-link targets surface as synthetic nodes
 * with `resolved: false` and an `unresolved:<raw>` id.
 */
export async function getLocalGraph(
  path: string,
  depth: number,
): Promise<LocalGraph> {
  try {
    return await invoke<LocalGraph>("get_local_graph", { path, depth });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Return the whole-vault link graph — one resolved node per indexed `.md`
 * file, one pseudo-node per unique unresolved wiki-link target, one
 * undirected edge per resolved link. Nodes carry their tags so the graph
 * filter panel can intersect without another IPC round-trip.
 */
export async function getLinkGraph(): Promise<LocalGraph> {
  try {
    return await invoke<LocalGraph>("get_link_graph");
  } catch (e) {
    throw normalizeError(e);
  }
}

export async function getResolvedAttachments(): Promise<Map<string, string>> {
  try {
    const record = await invoke<Record<string, string>>("get_resolved_attachments");
    return new Map(Object.entries(record));
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Attachment commands ────────────────────────────────────────────────────────

/**
 * Save raw image bytes into the vault's attachment folder.
 * Returns the vault-relative path using forward slashes.
 * folder: vault-relative path, e.g. "attachments"
 * filename: desired base name with extension, collision-avoidance handled by Rust
 * bytes: raw image bytes as a plain Array<number> (Tauri serializes Vec<u8> from JS Array)
 */
export async function saveAttachment(
  folder: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  try {
    return await invoke<string>("save_attachment", {
      folder,
      filename,
      bytes: Array.from(bytes),
    });
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Tag commands ───────────────────────────────────────────────────────────────

/** TAG-03: list all tags with usage counts, sorted alphabetically. */
export async function listTags(): Promise<TagUsage[]> {
  try {
    return await invoke<TagUsage[]>("list_tags");
  } catch (e) {
    throw normalizeError(e);
  }
}

/** TAG-04: list per-file occurrences of a specific tag. */
export async function getTagOccurrences(tag: string): Promise<TagOccurrence[]> {
  try {
    return await invoke<TagOccurrence[]>("get_tag_occurrences", { tag });
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Bookmarks commands (#12) ───────────────────────────────────────────────────

/** Load the vault's bookmark list (vault-relative paths) from .vaultcore/bookmarks.json. */
export async function loadBookmarks(vaultPath: string): Promise<string[]> {
  try {
    return await invoke<string[]>("load_bookmarks", { vaultPath });
  } catch (e) {
    throw normalizeError(e);
  }
}

/** Persist the vault's bookmark list to .vaultcore/bookmarks.json (atomic rename). */
export async function saveBookmarks(vaultPath: string, bookmarks: string[]): Promise<void> {
  try {
    await invoke<void>("save_bookmarks", { vaultPath, bookmarks });
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Custom CSS snippets (#64) ──────────────────────────────────────────────────

/**
 * List `*.css` filenames in `<vault>/.vaultcore/snippets/`. The directory is
 * created on first call so the user has a stable drop-in path, and an empty
 * list is returned when nothing is present.
 */
export async function listSnippets(vaultPath: string): Promise<string[]> {
  try {
    return await invoke<string[]>("list_snippets", { vaultPath });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Read the contents of a single snippet file. The Rust side vault-scope-
 * guards the path and rejects traversal attempts (`..`, absolute paths,
 * anything outside the snippets dir).
 */
export async function readSnippet(vaultPath: string, filename: string): Promise<string> {
  try {
    return await invoke<string>("read_snippet", { vaultPath, filename });
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Note templates (#67) ──────────────────────────────────────────────────────

/**
 * List `*.md` filenames in `<vault>/.vaultcore/templates/`. The directory is
 * created on first call so the user has a stable drop-in path.
 */
export async function listTemplates(vaultPath: string): Promise<string[]> {
  try {
    return await invoke<string[]>("list_templates", { vaultPath });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Read the contents of a single template file. The Rust side vault-scope-
 * guards the path and rejects traversal attempts.
 */
export async function readTemplate(vaultPath: string, filename: string): Promise<string> {
  try {
    return await invoke<string>("read_template", { vaultPath, filename });
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── HTML export (#61) ─────────────────────────────────────────────────────────

/**
 * Native save-as dialog. Returns the user-chosen absolute path, or `null` when
 * the dialog is cancelled. `defaultPath` suggests the starting filename.
 */
export async function pickSavePath(
  defaultPath: string,
  filters: { name: string; extensions: string[] }[] = [],
): Promise<string | null> {
  const picked = await saveDialog({ defaultPath, filters });
  return picked ?? null;
}

/**
 * Render the note at `notePath` to a self-contained HTML file at `outputPath`.
 * `themeCss` is inlined into a `<style>` tag in the exported document so it
 * renders correctly offline without the vault.
 */
export async function exportNoteHtml(
  notePath: string,
  outputPath: string,
  themeCss: string,
): Promise<void> {
  try {
    await invoke<void>("export_note_html", { notePath, outputPath, themeCss });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Same rendering pipeline as `exportNoteHtml`, but returns the HTML string
 * instead of writing a file. The PDF-export flow feeds this into a hidden
 * iframe and calls `window.print()`.
 */
export async function renderNoteHtml(
  notePath: string,
  themeCss: string,
): Promise<string> {
  try {
    return await invoke<string>("render_note_html", { notePath, themeCss });
  } catch (e) {
    throw normalizeError(e);
  }
}

// ── Semantic search (#201) ───────────────────────────────────────────────────

/**
 * Kick off the resumable initial-embed pass over the currently-open vault.
 * The backend runs a background worker that walks every `.md` file, hashes
 * it, and enqueues stale/new files through the embed pipeline. Progress is
 * emitted via the `embed://reindex_progress` Tauri event — subscribe with
 * {@link listenReindexProgress}.
 *
 * Returns immediately (the command just parks the worker thread). No-op if
 * the backend was built without the embeddings feature or the bundled
 * model is missing.
 */
export async function reindexVault(): Promise<void> {
  try {
    await invoke<void>("reindex_vault");
  } catch (e) {
    throw normalizeError(e);
  }
}

/** Cancel the in-flight reindex (no-op if none is running). */
export async function cancelReindex(): Promise<void> {
  try {
    await invoke<void>("cancel_reindex");
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * #244 — persist the semantic-search toggle and (re)arm or tear down
 * the embedding stack on the backend to match.
 *
 * Setting this to `false` at runtime drops the `Arc<EmbeddingService>`
 * held by the backend so the ~200-400 MB ONNX session is released.
 * Setting it to `true` lazy-loads the model against the currently open
 * vault (no-op when no vault is open — re-runs on the next `open_vault`).
 */
export async function setSemanticEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke<void>("set_semantic_enabled", { enabled });
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * #286 — wipe `<vault>/.vaultcore/embeddings/` and trigger a full reindex.
 * The user-facing escape hatch from the drift bug where the checkpoint
 * falsely claims files are embedded while the vector index is missing
 * their vectors. Returns once the IPC returns — the reindex itself runs
 * on a background thread and reports progress via the usual
 * `embed://reindex_progress` event stream.
 */
export async function refreshAllEmbeddings(): Promise<void> {
  try {
    await invoke<void>("refresh_all_embeddings");
  } catch (e) {
    throw normalizeError(e);
  }
}
