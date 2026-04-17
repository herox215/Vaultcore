// Helpers for rendering embedded canvas nodes (#71, phase 3).
// All functions here are pure (no IPC) so the view layer can unit-test
// classification and path resolution without spinning up the app.

import { IMAGE_EXTS, getExtension } from "../tabKind";

/** True if `fileRel` names an image the canvas viewer should show inline. */
export function isImageFile(fileRel: string): boolean {
  return IMAGE_EXTS.has(getExtension(fileRel));
}

/** True if `fileRel` is a markdown note whose body we render as preview. */
export function isMarkdownFile(fileRel: string): boolean {
  const ext = getExtension(fileRel);
  return ext === "md" || ext === "markdown";
}

/**
 * Join a canvas-file-node's vault-relative `file` field onto an absolute
 * vault path. Both `/` and `\` separators are normalised so the result
 * is safe to pass to `convertFileSrc` / `readFile`.
 */
export function resolveVaultAbs(
  vaultPath: string,
  fileRel: string,
): string {
  const root = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = fileRel.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${root}/${rel}`;
}

/**
 * Extract a short "preview" slice from a markdown body so a file-node card
 * can show something the reader recognizes at-a-glance. Strips YAML
 * frontmatter and collapses whitespace — we hand the remainder to the
 * full markdown renderer so wiki-links and embeds still render.
 */
export function canvasFilePreview(body: string, maxChars = 800): string {
  let text = body;
  if (text.startsWith("---")) {
    const closeIdx = text.indexOf("\n---", 3);
    if (closeIdx !== -1) {
      text = text.slice(closeIdx + 4).replace(/^\s+/, "");
    }
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd() + "…";
  }
  return text;
}
