/**
 * #357 — canonical resolver for attachment render sources.
 *
 * Every frontend code path that renders an image or other binary
 * attachment from disk MUST call `resolveAttachmentSrc` so the
 * encrypted-folder branch is handled uniformly. Four callsites today
 * (ImagePreview, embedPlugin, markdownRenderer, CanvasRenderer);
 * future callsites should import from here too — the helper is the
 * boundary between "plaintext asset:// fast path" and
 * "decrypt-via-IPC blob: path" so no renderer has to remember the
 * branch.
 *
 * Contract:
 * - Plain vault files → `asset://` URL (zero IPC, zero allocation).
 * - Files inside an encrypted folder → call `read_attachment_bytes`,
 *   wrap in `blob:` URL via `URL.createObjectURL`. Caller is
 *   responsible for revoking the URL (see `releaseAttachmentSrc`) on
 *   component destroy / `abs` change to avoid leaking the decrypted
 *   bytes in memory.
 * - `PathLocked` / missing file / malformed path → returns null. The
 *   caller renders an empty / placeholder state.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { get } from "svelte/store";

import { readAttachmentBytes } from "../../ipc/commands";
import { encryptedPaths } from "../../store/encryptedFoldersStore";
import { vaultStore } from "../../store/vaultStore";

/**
 * Return `true` when `abs` sits inside any manifest-registered
 * encrypted folder of the currently-open vault. Kept synchronous and
 * non-reactive so callers can use it inside `$derived` without
 * wiring another subscription.
 */
export function isInsideEncryptedFolder(abs: string): boolean {
  const vault = get(vaultStore).currentPath;
  if (!vault) return false;
  // Normalize separators — abs may use backslashes on Windows.
  const normAbs = abs.replace(/\\/g, "/");
  const normVault = vault.replace(/\\/g, "/");
  if (!normAbs.startsWith(normVault)) return false;
  const rel = normAbs.slice(normVault.length).replace(/^\/+/, "");
  const paths = get(encryptedPaths);
  for (const p of paths) {
    if (rel === p || rel.startsWith(p + "/")) return true;
  }
  return false;
}

/**
 * Resolve an attachment absolute path to a render-ready URL.
 *
 * Synchronous return for the plain-vault fast path (asset:// URL).
 * Encrypted-folder paths return a `Promise<string | null>` — callers
 * in Svelte components typically bind this to `{#await}` or resolve
 * inside a `$effect` and assign the result to local state.
 *
 * Returns `null` on IPC failure (locked folder, missing file) so the
 * caller can render an empty image without swallowing the error
 * silently — pair with `console.warn` at the callsite if debugging.
 */
export function resolveAttachmentSrc(abs: string): string | Promise<string | null> {
  if (!isInsideEncryptedFolder(abs)) {
    return convertFileSrc(abs);
  }
  return (async () => {
    try {
      const bytes = await readAttachmentBytes(abs);
      // Heuristic content-type from extension — browsers accept
      // `application/octet-stream` for <img>, but a proper MIME hint
      // avoids flashes of alt-text for a few frames.
      const mime = guessMime(abs);
      const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  })();
}

/**
 * Release a blob URL produced by `resolveAttachmentSrc`. Safe to call
 * on plain `asset://` URLs (no-op) so components can pass any URL
 * they previously received without branching.
 */
export function releaseAttachmentSrc(url: string | null | undefined): void {
  if (!url) return;
  if (url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "heic": return "image/heic";
    case "pdf": return "application/pdf";
    case "mp4": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "m4a": return "audio/mp4";
    default: return "application/octet-stream";
  }
}
