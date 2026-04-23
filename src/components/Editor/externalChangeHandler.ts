// Pure decision logic for watcher-driven "modify" events on open tabs.
//
// Split out of EditorPane.svelte so the branches (byte-identical skip / clean
// merge / conflict) can be unit-tested without a Svelte harness.
//
// Why this exists: the previous inline handler never refreshed
// `lastSavedHash` after a merge, so the next autosave compared a stale
// expected-hash against the freshly-written disk hash and re-entered the
// merge path — surfacing "Externe Änderungen wurden eingebunden" even when
// the user hadn't touched the file in another tool. A second source of
// spurious mismatches is our own write slipping past the 500ms
// `WriteIgnoreList` TTL on slow saves; the byte-identical shortcut collapses
// that case to a hash-sync with no user-visible toast.

export interface ExternalModifyDeps {
  getFileHash: (path: string) => Promise<string>;
  mergeExternalChange: (
    path: string,
    local: string,
    base: string,
  ) => Promise<{
    outcome: "clean" | "conflict";
    merged_content: string;
    new_hash: string | null;
  }>;
  /** SHA-256 hex of the given UTF-8 string. Injected so tests can stub it. */
  sha256Hex: (s: string) => Promise<string>;
}

export type ExternalModifyAction =
  | { kind: "sync-hash"; diskHash: string }
  | { kind: "clean-merge"; mergedContent: string; diskHash: string }
  | { kind: "conflict"; diskHash: string };

export interface ExternalModifyInput {
  path: string;
  editorContent: string;
  lastSavedContent: string;
}

/**
 * Decide what to do when the watcher reports an external "modify" for an
 * open tab.
 *
 * Contract:
 * - `sync-hash`: disk content is byte-identical to the editor buffer. The
 *   caller must only refresh `lastSavedHash` (and drop `isDirty`); no merge,
 *   no toast. Fires for self-writes that slipped past `WriteIgnoreList` and
 *   for external touches that produced identical bytes (git checkout same
 *   commit, Time Machine, Spotlight metadata writes).
 * - `clean-merge`: disk diverged from our base snapshot; the three-way
 *   merge resolved cleanly AND the backend persisted the merged bytes to
 *   disk (#339). The caller must replace the CM6 doc with `mergedContent`
 *   and record `diskHash` as the new `lastSavedHash`. The caller MUST NOT
 *   call `writeFile` again — the backend already wrote.
 * - `conflict`: merge failed; the backend did NOT write. The caller keeps
 *   the editor's local content but still records `diskHash` (the external
 *   version still on disk) so the next autosave writes through
 *   deliberately (the documented "lokale Version behalten" behaviour).
 */
export async function decideExternalModifyAction(
  deps: ExternalModifyDeps,
  input: ExternalModifyInput,
): Promise<ExternalModifyAction> {
  const [diskHash, editorHash] = await Promise.all([
    deps.getFileHash(input.path),
    deps.sha256Hex(input.editorContent),
  ]);

  if (diskHash === editorHash) {
    return { kind: "sync-hash", diskHash };
  }

  const result = await deps.mergeExternalChange(
    input.path,
    input.editorContent,
    input.lastSavedContent,
  );

  if (result.outcome === "clean") {
    // Prefer the backend's `new_hash` (#339): the backend just wrote the
    // merged bytes, so its hash is the authoritative next-disk-state. The
    // `diskHash` computed before the merge call reflects the PRE-merge
    // external content and is stale by the time we get here. Fall back to
    // hashing the merged content on the rare path where `new_hash` is
    // missing (older backend).
    const mergedHash =
      result.new_hash ?? (await deps.sha256Hex(result.merged_content));
    return {
      kind: "clean-merge",
      mergedContent: result.merged_content,
      diskHash: mergedHash,
    };
  }
  return { kind: "conflict", diskHash };
}

/**
 * SHA-256 hex of a UTF-8 string via Web Crypto. Matches the backend
 * `hash_bytes` output (lowercase hex of `Sha256::digest(bytes)`).
 */
export async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
