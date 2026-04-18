// Minimal YAML-ish reader/writer for the Properties panel.
//
// Scope: flat top-level `key: value` pairs, where a value is either a scalar
// (single string) or a list (array of strings). Lists are modelled uniformly
// as `values: string[]` with a `listStyle` flag that records whether the
// source used list syntax — so `title: Hello` round-trips as scalar while
// `tags: [a]` round-trips as a single-entry flow list.
//
// Supported list syntaxes on parse:
//   - Flow form:    `key: [a, b, c]`   (entries may be quoted with " or ')
//   - Empty flow:   `key: []`
//   - Block seq:    `key:\n  - a\n  - b`
//
// Serializer always emits flow form for lists (block sequences collapse to
// flow on write). Entries are quoted only when necessary (containing `,`,
// `[`, `]`, `"`, or leading/trailing whitespace, or when empty).

import { detectFrontmatter } from "../components/Editor/frontmatterPlugin";

export interface Property {
  key: string;
  values: string[];
  listStyle: boolean;
}

export interface FrontmatterParseResult {
  properties: Property[];
  region: { from: number; to: number } | null;
}

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/;
const BLOCK_ITEM_RE = /^(\s+)-\s+(.*)$/;

export function parseFrontmatter(docText: string): FrontmatterParseResult {
  const region = detectFrontmatter(docText);
  if (!region) return { properties: [], region: null };

  const lines = region.body.split(/\r?\n/);
  const properties: Property[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = KEY_RE.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";

    // Empty scalar — may be the start of a block sequence on the next lines.
    if (rawValue === "") {
      const [items, consumed] = consumeBlockSequence(lines, i + 1);
      if (consumed > 0) {
        properties.push({ key, values: items, listStyle: true });
        i += consumed;
        continue;
      }
      properties.push({ key, values: [""], listStyle: false });
      continue;
    }

    // Flow list: `[...]` covering the whole value.
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      const items = splitFlowList(inner);
      properties.push({ key, values: items, listStyle: true });
      continue;
    }

    // Plain scalar.
    properties.push({ key, values: [rawValue], listStyle: false });
  }

  return { properties, region: { from: region.from, to: region.to } };
}

function consumeBlockSequence(lines: string[], start: number): [string[], number] {
  const items: string[] = [];
  let consumed = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    const m = BLOCK_ITEM_RE.exec(line);
    if (!m) break;
    items.push(stripQuotes((m[2] ?? "").trim()));
    consumed++;
  }
  return [items, consumed];
}

function splitFlowList(inner: string): string[] {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') {
        escape = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf.trim());
  return out;
}

function stripQuotes(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      const inner = raw.slice(1, -1);
      if (first === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return inner;
    }
  }
  return raw;
}

function needsQuoting(entry: string): boolean {
  if (entry.length === 0) return true;
  if (/[,\[\]"]/.test(entry)) return true;
  if (entry !== entry.trim()) return true;
  return false;
}

function quoteEntry(entry: string): string {
  const escaped = entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function formatEntry(entry: string): string {
  return needsQuoting(entry) ? quoteEntry(entry) : entry;
}

function serializeValue(prop: Property): string {
  if (!prop.listStyle && prop.values.length === 1) {
    return prop.values[0] ?? "";
  }
  const body = prop.values.map(formatEntry).join(", ");
  return `[${body}]`;
}

export function serializeBody(properties: Property[]): string {
  return properties
    .filter((p) => p.key.trim().length > 0)
    .map((p) => `${p.key}: ${serializeValue(p)}`)
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
