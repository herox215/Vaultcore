// #261 — recentFiles derivation extracted from OmniSearch so the
// OmniSearch tabStore subscriber can skip reassigning state when the
// derived list hasn't changed.
//
// `tabStore` emits on every per-tab edit (setDirty, updateScrollPos,
// setLastSavedHash, ...). Before this memo, the OmniSearch subscriber
// recomputed + reassigned `recentFiles` on every emission — unnecessary
// work on the keystroke hot path. This module produces a stable signature
// so subscribers can short-circuit when the first-N reversed file paths
// are unchanged.

export interface RecentEntry {
  path: string;
  filename: string;
}

/**
 * Compute the unique last-N reversed file paths from a list of tabs.
 * Preserves existing behavior — the "recent" list is the most recently
 * opened tabs (we walk tabs in reverse, dedupe by filePath, cap at `limit`).
 */
export function computeRecentFiles(
  tabs: ReadonlyArray<{ filePath: string }>,
  limit: number = 8,
): RecentEntry[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (let i = tabs.length - 1; i >= 0; i--) {
    const path = tabs[i]!.filePath;
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
    if (unique.length >= limit) break;
  }
  return unique.map((p) => ({
    path: p,
    filename: p.split("/").pop() ?? p,
  }));
}

/**
 * Cheap signature of the current recents list — the joined reversed
 * filePaths. Stable across unrelated tabStore fields (isDirty, scrollPos,
 * lastSavedHash, etc.), changes only when the dedupe-ordered filePath
 * prefix actually shifts.
 */
export function recentsSignature(
  tabs: ReadonlyArray<{ filePath: string }>,
  limit: number = 8,
): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (let i = tabs.length - 1; i >= 0; i--) {
    const path = tabs[i]!.filePath;
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
    if (unique.length >= limit) break;
  }
  return unique.join("\n");
}
