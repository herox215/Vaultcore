// Flat-row model for the virtualized sidebar tree (#253).
//
// The sidebar used to be a recursive `<TreeNode>` tree where every node
// subscribed to `treeRevealStore` independently. At 100k notes that produced
// N store subscriptions and unbounded DOM — both of which blew past the
// spec's <16ms keystroke budget. This module replaces the recursive walk
// with a flat array: rendering 50k folders costs one `flattenTree` call
// (O(n)), and the windowed renderer emits only viewport rows.
//
// Lazy-load model (preserved from TreeNode.loadChildren):
//   - `expanded: true` + `childrenLoaded: true`  → children emitted with depth+1
//   - `expanded: true` + `childrenLoaded: false` → folder row emitted, no children
//     (the expand handler triggers listDirectory; when it resolves and the
//     tree model is updated, flattenTree runs again and emits the children).
//   - `expanded: false`                           → folder row emitted, no children
//
// No depth cap: Obsidian vaults can legitimately nest 6-10 levels; we defer
// to the virtualizer to keep memory bounded.

import type { DirEntry } from "../types/tree";
import type { SortBy } from "./treeState";
import { sortEntries } from "./treeState";

/**
 * Per-folder state stored in the tree model. The `childrenLoaded` flag is
 * load-tracking ONLY — it tells flattenTree whether to descend. It is NOT
 * the same as `expanded` (a folder can be expanded with children not yet
 * fetched, which is the common case for a folder freshly opened by the user).
 */
export interface FolderState {
  /** Resolved children for this folder (undefined until listDirectory returns). */
  children: readonly DirEntry[] | undefined;
  childrenLoaded: boolean;
  loading: boolean;
}

/** Flat row emitted by `flattenTree`. `depth` is zero-based (root = 0). */
export interface FlatRow {
  /** Absolute path — stable identity, used as the virtual recycler key. */
  path: string;
  /** Vault-relative path (forward slashes). Used for treeState/expanded lookups. */
  relPath: string;
  name: string;
  depth: number;
  isDir: boolean;
  isMd: boolean;
  isSymlink: boolean;
  /** Current expand state (false for files). */
  expanded: boolean;
  /** True iff `expanded && !childrenLoaded` — used to render a pending spinner. */
  loading: boolean;
  /**
   * True when the flat row has descendants currently contributing rows.
   * Equivalent to `isDir && expanded && childrenLoaded && children.length > 0`.
   * Consumers use this to decide whether a "keyboard arrow-down skips over
   * my subtree" operation is needed.
   */
  hasRenderedChildren: boolean;
  /** True iff listDirectory has resolved for this folder at least once. */
  childrenLoaded: boolean;
}

export interface TreeModel {
  /** Vault absolute path — used to compute relative paths. */
  vaultPath: string;
  /** Root entries (listDirectory(vaultPath)). */
  rootEntries: readonly DirEntry[];
  /**
   * Per-folder state, keyed by the folder's absolute path. Missing entries
   * are treated as "children not loaded, not loading". The root itself is
   * represented by `rootEntries` and is not stored in this map.
   */
  folders: ReadonlyMap<string, FolderState>;
  /**
   * Set of vault-relative folder paths that are currently expanded. Mirrors
   * the persisted `TreeState.expanded` list so flatten is a pure function of
   * the model.
   */
  expanded: ReadonlySet<string>;
  sortBy: SortBy;
}

/** Compute a vault-relative path with forward slashes, or `absPath` if it's outside. */
export function toRelPath(absPath: string, vaultPath: string): string {
  const norm = absPath.replace(/\\/g, "/");
  const vault = vaultPath.replace(/\\/g, "/");
  if (norm === vault) return "";
  if (norm.startsWith(vault + "/")) return norm.slice(vault.length + 1);
  return norm;
}

function buildRow(
  entry: DirEntry,
  depth: number,
  vaultPath: string,
  model: TreeModel,
): FlatRow {
  const relPath = toRelPath(entry.path, vaultPath);
  const expanded = entry.is_dir && model.expanded.has(relPath);
  const fs = model.folders.get(entry.path);
  const childrenLoaded = fs?.childrenLoaded ?? false;
  const loading = expanded && !childrenLoaded && (fs?.loading ?? true);
  const childCount = fs?.children?.length ?? 0;
  return {
    path: entry.path,
    relPath,
    name: entry.name,
    depth,
    isDir: entry.is_dir,
    isMd: entry.is_md,
    isSymlink: entry.is_symlink,
    expanded,
    loading,
    hasRenderedChildren: expanded && childrenLoaded && childCount > 0,
    childrenLoaded,
  };
}

/**
 * Recursively walk the tree model, emitting one FlatRow per visible node.
 * Collapsed folders do NOT emit children; expanded-but-not-loaded folders
 * emit only the folder row (children come later once listDirectory lands).
 */
export function flattenTree(model: TreeModel): FlatRow[] {
  const out: FlatRow[] = [];
  const sortedRoot = sortEntries(model.rootEntries, model.sortBy);

  const walk = (entries: readonly DirEntry[], depth: number): void => {
    for (const entry of entries) {
      out.push(buildRow(entry, depth, model.vaultPath, model));
      if (!entry.is_dir) continue;
      const relPath = toRelPath(entry.path, model.vaultPath);
      if (!model.expanded.has(relPath)) continue;
      const fs = model.folders.get(entry.path);
      if (!fs || !fs.childrenLoaded || !fs.children) continue;
      const sortedChildren = sortEntries(fs.children, model.sortBy);
      walk(sortedChildren, depth + 1);
    }
  };

  walk(sortedRoot, 0);
  return out;
}

/**
 * Return the ordered list of ancestor folder rel-paths for a target.
 * E.g. "notes/daily/today.md" → ["notes", "notes/daily"]. The target
 * itself is NOT included.
 */
export function ancestorRelPaths(relPath: string): string[] {
  const parts = relPath.split("/").filter((p) => p.length > 0);
  if (parts.length <= 1) return [];
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}
