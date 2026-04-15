// Daily Notes helpers (#59).
//
// The date-format tokens supported here are intentionally a minimal subset of
// the Obsidian convention:
//   - YYYY — 4-digit local year
//   - MM   — 2-digit local month (01-12)
//   - DD   — 2-digit local day-of-month (01-31)
// Anything else in the format string is copied through verbatim, so e.g.
// "YYYY-MM-DD" and "DD.MM.YYYY" both work. Fancier tokens (day names, weeks,
// locale formatting) are out of scope for this issue.

export const DEFAULT_DAILY_DATE_FORMAT = "YYYY-MM-DD";

/**
 * Format a Date into a filename stem using the supported subset of tokens.
 * Local time is used — the goal is "today's note" as the user perceives it,
 * not a UTC rollover.
 */
export function formatDailyNoteDate(date: Date, format: string): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  // Longest tokens first so MM inside YYYY-MM never clobbers a stray M/D pair.
  return format
    .replace(/YYYY/g, yyyy)
    .replace(/MM/g, mm)
    .replace(/DD/g, dd);
}

/**
 * Build the `.md` filename for `date` given a raw format string.
 * If the rendered stem ends in `.md` (or `.markdown`) it is kept as-is;
 * otherwise `.md` is appended. Empty/whitespace stems fall back to the
 * default format so we never ask the IPC layer to create a nameless file.
 */
export function dailyNoteFilename(date: Date, format: string): string {
  const raw = formatDailyNoteDate(date, format).trim();
  const stem = raw.length > 0 ? raw : formatDailyNoteDate(date, DEFAULT_DAILY_DATE_FORMAT);
  if (/\.md$/i.test(stem) || /\.markdown$/i.test(stem)) return stem;
  return `${stem}.md`;
}

/**
 * Split a vault-relative folder spec into its segments, dropping empty
 * pieces and leading/trailing slashes. Returns `[]` for "", "/", or "  ".
 * Backslashes are treated as separators so Windows-style input from a
 * Settings field still parses cleanly.
 */
export function splitFolderSegments(folder: string): string[] {
  return folder
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
