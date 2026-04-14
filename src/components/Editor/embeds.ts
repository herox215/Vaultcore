// Attachment resolver map for the wiki-embed (`![[file.png]]`) plugin.
// Mirrors the shape of `wikiLink.ts` — a module-level Map populated once per
// vault open via `setResolvedAttachments(await getResolvedAttachments())` from
// EditorPane, so decoration lookups are synchronous and IPC-free.

/**
 * Lowercased filename-with-extension → vault-relative path.
 * E.g. `"photo.png"` → `"images/photo.png"`.
 */
let resolvedAttachments: Map<string, string> = new Map();

export function setResolvedAttachments(map: Map<string, string>): void {
  resolvedAttachments = map;
}

/**
 * Add or replace a single entry in the attachment map. Used by the paste/drop
 * handler after `save_attachment` returns, so the just-saved image resolves on
 * the next embed-plugin rebuild without waiting for a full `get_resolved_attachments`
 * refresh (the file-watcher event for self-writes is suppressed via write_ignore).
 */
export function addResolvedAttachment(filename: string, relPath: string): void {
  resolvedAttachments.set(filename.trim().toLowerCase(), relPath);
}

/**
 * Synchronous lookup for the embed ViewPlugin. Accepts the raw filename as
 * written inside `![[...]]` and returns the vault-relative path, or `null`
 * if the attachment is missing.
 *
 * Matching is case-insensitive because users routinely type `![[IMG_0001.JPG]]`
 * for files named `img_0001.jpg`.
 */
export function resolveAttachment(filename: string): string | null {
  // Strip an embed-style trailing section reference (`foo.png#anchor`) just in
  // case — the plugin captures `#heading` separately but a defensive strip
  // keeps this helper honest for ad-hoc callers.
  const hashIdx = filename.indexOf("#");
  const cleaned = hashIdx === -1 ? filename : filename.slice(0, hashIdx);
  return resolvedAttachments.get(cleaned.trim().toLowerCase()) ?? null;
}
