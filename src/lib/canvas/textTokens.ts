// Wiki-link tokenizer for canvas text nodes.
//
// Canvas text nodes store plain text on disk. To render `[[target]]` and
// `![[image.png]]` inside those cards, we split the raw string into a
// flat list of segments so the renderer can emit links, images, and plain
// text fragments without re-parsing on every repaint.
//
// Scope:
//   - `[[target]]` and `[[target|alias]]` → link segment
//   - `![[image.ext]]` (known image extension) → image segment
//   - Any other `![[target]]` (note/canvas embed) falls back to a link
//     segment — full note/canvas embeds are deferred (#162 out-of-scope)

export type CanvasTextSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; target: string; display: string }
  | { kind: "image"; target: string };

const WIKI_RE = /(!?)\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
]);

function hasImageExt(target: string): boolean {
  const dot = target.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(target.slice(dot + 1).toLowerCase());
}

export function tokenizeCanvasText(text: string): CanvasTextSegment[] {
  if (text.length === 0) return [];

  const out: CanvasTextSegment[] = [];
  WIKI_RE.lastIndex = 0;
  let idx = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_RE.exec(text)) !== null) {
    if (m.index > idx) {
      out.push({ kind: "text", text: text.slice(idx, m.index) });
    }
    const isEmbed = m[1] === "!";
    const target = m[2] ?? "";
    const alias = m[3];
    if (isEmbed && hasImageExt(target)) {
      out.push({ kind: "image", target });
    } else {
      out.push({ kind: "link", target, display: alias ?? target });
    }
    idx = m.index + m[0].length;
  }
  if (idx < text.length) {
    out.push({ kind: "text", text: text.slice(idx) });
  }
  return out;
}
