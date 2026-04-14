// Typed IPC layer — the ONLY place in the frontend that imports `invoke`.
// Components and stores MUST go through these wrappers so:
//   1. Every Tauri error surfaces as a normalized `VaultError` (T-02-02).
//   2. The T-02 vault-scope guard on the Rust side cannot be bypassed by a
//      component calling `invoke` directly with an arbitrary path (T-02-01).

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { VaultError } from "../types/errors";
import { isVaultError } from "../types/errors";
import type { VaultInfo, VaultStats, RecentVault } from "../types/vault";
import type { DirEntry } from "../types/tree";
import type { SearchResult, FileMatch } from "../types/search";
import type { BacklinkEntry, UnresolvedLink, RenameResult } from "../types/links";
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
}

/**
 * SYNC-06/07: Perform a three-way merge for an external file change.
 * base = lastSavedContent, left = editorContent, right = current disk content.
 * Returns outcome ("clean" | "conflict") and the merged content.
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
 * Return all outgoing wiki-links from a vault-relative source path.
 */
export async function getOutgoingLinks(path: string): Promise<any[]> {
  try {
    return await invoke<any[]>("get_outgoing_links", { path });
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
