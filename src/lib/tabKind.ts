// Extension-based classifier used when opening a file path as a new tab (#49).
// Pure helper — no IPC, no filesystem access. The caller is responsible for
// subsequently loading the file content (or, for "unsupported", skipping it).

/** Image extensions that render via `<img src={convertFileSrc(abs)} />`. */
export const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
]);

/**
 * Extensions that open read-only in the CodeMirror viewer. Known-safe plain
 * text / config file extensions — these never trigger the UTF-8 fallback path.
 */
export const TEXT_EXTS = new Set([
  "txt",
  "log",
  "csv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
]);

/** Tab viewer — what UI branch EditorPane should render for a tab. */
export type TabKind = "markdown" | "image" | "text" | "unsupported";

/**
 * Extract the lowercase extension from a path (without the leading dot).
 * Returns "" if the basename has no dot.
 */
export function getExtension(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Decide the viewer for a file path based on its extension. Files with
 * unknown extensions return "text" so the caller tries readFile and falls
 * back to "unsupported" if the bytes aren't valid UTF-8.
 */
export function getTabKind(path: string): TabKind {
  const ext = getExtension(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "text";
  // Unknown extension — caller should try UTF-8 read and fall back
  // to "unsupported" if decoding fails.
  return "text";
}
