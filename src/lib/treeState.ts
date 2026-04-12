/**
 * FILE-06/FILE-07: Per-vault tree state persistence.
 *
 * State shape (CONTEXT D-19):
 *   { sortBy: 'name'|'modified'|'created', expanded: string[] }
 *
 * Key: `vaultcore-tree-state:{first 16 hex chars of SHA-256(vault_path)}`
 *
 * sortEntries enforces "folders before files" within each sort order (UI-SPEC).
 * Null/missing timestamps sort last so older filesystems (Linux ext4 without btime)
 * don't break the UI.
 */
import type { DirEntry } from "../types/tree";

export type SortBy = "name" | "modified" | "created";

export interface TreeState {
  sortBy: SortBy;
  expanded: string[]; // vault-relative paths
}

export const DEFAULT_TREE_STATE: TreeState = { sortBy: "name", expanded: [] };

const VALID_SORT_BY: readonly SortBy[] = ["name", "modified", "created"];

export async function vaultHashKey(vaultPath: string): Promise<string> {
  const data = new TextEncoder().encode(vaultPath);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `vaultcore-tree-state:${hex.slice(0, 16)}`;
}

export async function loadTreeState(vaultPath: string): Promise<TreeState> {
  try {
    const key = await vaultHashKey(vaultPath);
    const raw = localStorage.getItem(key);
    if (!raw) return { ...DEFAULT_TREE_STATE };
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sortBy" in parsed &&
      "expanded" in parsed &&
      VALID_SORT_BY.includes((parsed as TreeState).sortBy) &&
      Array.isArray((parsed as TreeState).expanded)
    ) {
      return parsed as TreeState;
    }
    return { ...DEFAULT_TREE_STATE };
  } catch {
    return { ...DEFAULT_TREE_STATE };
  }
}

export async function saveTreeState(
  vaultPath: string,
  state: TreeState
): Promise<void> {
  const key = await vaultHashKey(vaultPath);
  localStorage.setItem(key, JSON.stringify(state));
}

/**
 * Sort entries with folders always first, then apply the chosen order within each group.
 * Null/missing timestamps sort last so a single bad entry doesn't break the whole list.
 */
export function sortEntries(
  entries: readonly DirEntry[],
  sortBy: SortBy
): DirEntry[] {
  const folders = entries.filter((e) => e.is_dir);
  const files = entries.filter((e) => !e.is_dir);

  const byName = (a: DirEntry, b: DirEntry) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase());

  const byTimestamp =
    (key: "modified" | "created") =>
    (a: DirEntry, b: DirEntry) => {
      const av = a[key];
      const bv = b[key];
      if (av === null && bv === null) return byName(a, b);
      if (av === null) return 1; // null sorts last
      if (bv === null) return -1;
      return bv - av; // descending
    };

  // Folders always sorted alphabetically per UI-SPEC
  const fileSort =
    sortBy === "name" ? byName : byTimestamp(sortBy as "modified" | "created");

  return [
    ...folders.slice().sort(byName),
    ...files.slice().sort(fileSort),
  ];
}
