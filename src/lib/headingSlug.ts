// Heading-slug algorithm — mirror of `src-tauri/src/indexer/anchors.rs::slugify`.
//
// Used by the wiki-link click handler and the embed plugin to compare a
// heading-ref's raw value (e.g. `Multi Word`) against the slug Rust stored
// at index time (`multi-word`). The two sides MUST stay in lockstep —
// `test-fixtures/slug_parity.json` pins identical output for every case
// across both languages.
//
// Algorithm (matches Rust):
//   1. lowercase (Unicode-aware via `String.prototype.toLowerCase`)
//   2. whitespace runs → single `-` (only when boundary makes sense)
//   3. keep `\p{L}\p{N}` plus `-` and `_`; drop everything else
//   4. trim leading / trailing `-`
//
// We do NOT collapse adjacent dashes from dropped characters because Rust
// doesn't either — only whitespace creates dashes.

/** Re-exported alphanumeric test that stays in sync with Rust's
 * `char::is_alphanumeric`. JS `\p{L}\p{N}` matches the same Unicode
 * categories. */
const ALNUM_RE = /[\p{L}\p{N}]/u;

export function slugify(text: string): string {
  let out = "";
  let lastWasDash = false;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (!lastWasDash && out.length > 0) {
        out += "-";
        lastWasDash = true;
      }
      continue;
    }
    if (ALNUM_RE.test(ch) || ch === "-" || ch === "_") {
      out += ch.toLowerCase();
      lastWasDash = false;
      continue;
    }
    // punctuation / emoji / other — drop without breaking dash-state
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  while (out.startsWith("-")) out = out.slice(1);
  return out;
}
