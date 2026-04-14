// Minimal YAML-ish reader/writer for the Properties panel.
// Scope: flat top-level `key: value` pairs only. Values are treated as
// opaque strings (what the user typed, verbatim). Nested structures,
// multi-line scalars, and YAML comments are preserved as raw-string
// values on read but will be coerced to single-line on write — which is
// acceptable for the "edit simple frontmatter from the sidebar" use case.

import { detectFrontmatter } from "../components/Editor/frontmatterPlugin";

export interface Property {
  key: string;
  value: string;
}

export interface FrontmatterParseResult {
  properties: Property[];
  region: { from: number; to: number } | null;
}

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/;

export function parseFrontmatter(docText: string): FrontmatterParseResult {
  const region = detectFrontmatter(docText);
  if (!region) return { properties: [], region: null };

  const lines = region.body.split(/\r?\n/);
  const properties: Property[] = [];
  for (const line of lines) {
    const match = KEY_RE.exec(line);
    if (!match) continue;
    const [, key = "", rawValue = ""] = match;
    properties.push({ key, value: rawValue });
  }
  return { properties, region: { from: region.from, to: region.to } };
}

export function serializeBody(properties: Property[]): string {
  return properties
    .filter((p) => p.key.trim().length > 0)
    .map((p) => `${p.key}: ${p.value}`)
    .join("\n");
}

export function serializeBlock(properties: Property[]): string {
  const body = serializeBody(properties);
  if (body.length === 0) return "";
  return `---\n${body}\n---\n`;
}

// Compute the replacement transaction for going from the current doc to
// the new property list. Returns the `from`/`to`/`insert` triple to pass
// to `view.dispatch({ changes: ... })`.
//
// Rules:
//   - If new list is empty AND doc has frontmatter: strip the block AND
//     one trailing blank line (the separator between frontmatter and body).
//   - If new list is non-empty AND doc has no frontmatter: insert the
//     block at position 0, followed by one blank separator line.
//   - Otherwise: replace the existing block in-place.
export function computeFrontmatterEdit(
  docText: string,
  properties: Property[],
): { from: number; to: number; insert: string } {
  const existing = detectFrontmatter(docText);
  const newBlock = serializeBlock(properties);

  if (!existing && newBlock === "") {
    return { from: 0, to: 0, insert: "" };
  }

  if (existing && newBlock === "") {
    let to = existing.to;
    if (docText.charAt(to) === "\n") to += 1;
    return { from: 0, to, insert: "" };
  }

  if (!existing) {
    // `newBlock` already ends with `\n`, so the existing doc content
    // follows immediately on the next line — no extra separator needed.
    return { from: 0, to: 0, insert: newBlock };
  }

  return { from: existing.from, to: existing.to, insert: newBlock };
}
