// HTML export helpers (#61).
//
// Pulls the currently applied theme's CSS custom properties off
// `document.documentElement` and serialises them into a `:root { … }` block
// that the Rust exporter inlines into the <head>. Only the tokens the
// readable-body stylesheet references are emitted — user snippets stay in the
// app, not the export (deliberately out of scope per issue #61).

const THEME_VARS = [
  "--color-bg",
  "--color-surface",
  "--color-border",
  "--color-text",
  "--color-text-muted",
  "--color-accent",
  "--color-accent-bg",
  "--color-selection",
  "--color-error",
  "--color-warning",
  "--color-success",
  "--color-code-bg",
  "--vc-font-body",
  "--vc-font-mono",
  "--vc-font-size",
] as const;

/**
 * Read the computed value of each known theme token on `<html>` and return a
 * `:root { --key: value; ... }` CSS string suitable for inlining. Empty /
 * unset properties are skipped. Safe to call under jsdom — unresolved
 * properties simply return empty strings.
 */
export function collectThemeCss(): string {
  if (typeof document === "undefined") return "";
  const root = document.documentElement;
  const computed = window.getComputedStyle(root);
  const lines: string[] = [];
  for (const name of THEME_VARS) {
    const value = computed.getPropertyValue(name).trim();
    if (value.length > 0) {
      lines.push(`  ${name}: ${value};`);
    }
  }
  if (lines.length === 0) return "";
  return `:root {\n${lines.join("\n")}\n}\n`;
}

/**
 * Strip any extension and trailing directory slashes from an absolute path to
 * produce a sensible default-filename stem for the save dialog.
 */
export function defaultExportFilename(notePath: string, ext: string): string {
  const last = notePath.split(/[\\/]/).pop() ?? "note";
  const stem = last.replace(/\.md$/i, "");
  return `${stem}.${ext}`;
}
