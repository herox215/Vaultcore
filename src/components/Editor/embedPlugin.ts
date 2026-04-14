// Wiki-embed and markdown-image ViewPlugin — inline rendering for issue #9.
//
// Supports three embed forms:
//   1. `![[image.png]]` and `![[image.png|300]]` — wiki-embed images, with
//      optional pixel sizing after `|`.
//   2. `![](path/to/image.png)` — standard markdown images; URL-decoded so
//      `Pasted%20image.png` also resolves. Kept for back-compat with content
//      authored before the paste handler switched to wiki-embed output.
//   3. `![[OtherNote]]` — note embeds. Rendered as a bordered block showing
//      the target file's raw markdown. Full rendering is a follow-up.
//
// Architecture mirrors `wikiLink.ts`:
//   - Module-level resolver maps (`embeds.ts` for attachments,
//     `wikiLink.ts` for notes) populated once per vault open from Rust.
//   - Decoration build is synchronous — every lookup is a Map.get().
//   - Note-embed content is fetched asynchronously via `readFile` and cached
//     in a module-level Map keyed by vault-relative path; a fetch kicks a
//     view dispatch on completion so the widget swaps in.

import { ViewPlugin, Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import { get } from "svelte/store";

import { resolveAttachment } from "./embeds";
import { resolveTarget } from "./wikiLink";
import { vaultStore } from "../../store/vaultStore";
import { readFile } from "../../ipc/commands";

// ── Regex ──────────────────────────────────────────────────────────────────────

/**
 * Matches `![[target]]`, `![[target|sizing]]`, `![[target#heading]]`, and the
 * combined `![[target#heading|sizing]]`. Captures:
 *   1 — target (path/filename, no `]`, `|`, or `#`)
 *   2 — heading (optional, after `#`)
 *   3 — sizing/alias text (optional, after `|`)
 *
 * The heading capture is parsed but not yet used for slicing — see PR notes.
 */
const WIKI_EMBED_RE = /!\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]*))?\]\]/g;

/** Matches `![alt](path)` — captures the path. */
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

// ── Cache for note-embed content ──────────────────────────────────────────────

/**
 * Vault-relative path → file content. Cleared on every plugin rebuild so edits
 * to the target note propagate without manual invalidation (the doc-version
 * debounce gates this to ~200 ms, so the cache still absorbs the rebuild burst).
 */
const noteContentCache: Map<string, string> = new Map();
/**
 * Paths whose `readFile` call is already in flight, used to suppress duplicate
 * IPC requests from back-to-back plugin rebuilds.
 */
const noteFetchInFlight: Set<string> = new Set();

function scheduleNoteFetch(view: EditorView, relPath: string): void {
  if (noteContentCache.has(relPath) || noteFetchInFlight.has(relPath)) return;
  const vault = get(vaultStore).currentPath;
  if (!vault) return;
  const abs = `${vault}/${relPath}`;
  noteFetchInFlight.add(relPath);
  void readFile(abs)
    .then((content) => {
      noteContentCache.set(relPath, content);
    })
    .catch(() => {
      noteContentCache.set(relPath, "");
    })
    .finally(() => {
      noteFetchInFlight.delete(relPath);
      // Kick the plugin to re-render now that we have content.
      if (!view.dom.isConnected) return;
      view.dispatch({ effects: [] });
    });
}

// ── Widgets ────────────────────────────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

function isImageFilename(name: string): boolean {
  return IMAGE_EXT_RE.test(name);
}

/**
 * Return the absolute vault path for a vault-relative asset path, or null
 * when the vault is not open. Uses forward slashes on all platforms —
 * `convertFileSrc` tolerates either.
 */
function absFromRel(relPath: string): string | null {
  const vault = get(vaultStore).currentPath;
  if (!vault) return null;
  const v = vault.replace(/\\/g, "/").replace(/\/$/, "");
  return `${v}/${relPath}`;
}

class ImageEmbedWidget extends WidgetType {
  constructor(readonly relPath: string, readonly sizePx: number | null) {
    super();
  }

  eq(other: ImageEmbedWidget): boolean {
    return this.relPath === other.relPath && this.sizePx === other.sizePx;
  }

  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-embed-img";
    const abs = absFromRel(this.relPath);
    img.src = abs ? convertFileSrc(abs) : "";
    img.alt = this.relPath;
    if (this.sizePx !== null) {
      img.style.width = `${this.sizePx}px`;
    }
    return img;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class NoteEmbedWidget extends WidgetType {
  constructor(readonly relPath: string, readonly content: string) {
    super();
  }

  eq(other: NoteEmbedWidget): boolean {
    return this.relPath === other.relPath && this.content === other.content;
  }

  toDOM(): HTMLElement {
    const block = document.createElement("div");
    block.className = "cm-embed-note";
    block.setAttribute("data-embed-path", this.relPath);
    // MVP: raw markdown text. A follow-up can pipe this through a proper
    // markdown renderer — keeping monospace for now so the user clearly
    // sees what content is being embedded without a half-rendered surprise.
    block.textContent = this.content;
    return block;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class BrokenEmbedWidget extends WidgetType {
  constructor(readonly target: string) {
    super();
  }

  eq(other: BrokenEmbedWidget): boolean {
    return this.target === other.target;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-embed-broken";
    span.textContent = `\u26A0 nicht gefunden: ${this.target}`;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ── Code block detection ───────────────────────────────────────────────────────

function isInsideCodeBlock(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolve(pos, 1);
  let cur: typeof node | null = node;
  while (cur) {
    const name = cur.type.name;
    if (
      name === "FencedCode" ||
      name === "CodeBlock" ||
      name === "InlineCode" ||
      name === "Code"
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

// ── Match types ────────────────────────────────────────────────────────────────

interface EmbedMatch {
  from: number;
  to: number;
  decoration: Decoration;
}

/**
 * Parse the sizing token that follows the `|` in a wiki-embed. Only a leading
 * positive integer is honored — everything else is treated as an alias and
 * ignored for image width.
 */
export function parseSizePx(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(\d+)/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Build decorations ──────────────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  const head = view.state.selection.main.head;

  const matches: EmbedMatch[] = [];

  // Wiki embeds: ![[target(#heading)?(|sizing)?]]
  WIKI_EMBED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_EMBED_RE.exec(text)) !== null) {
    const rawTarget = m[1];
    if (rawTarget === undefined) continue;
    const from = m.index;
    const to = from + m[0].length;

    // Skip code blocks / inline code.
    if (isInsideCodeBlock(view.state, from)) continue;

    // Cursor inside → show raw syntax, do not replace.
    if (head >= from && head <= to) continue;

    const target = rawTarget.trim();
    const sizePx = parseSizePx(m[3]);

    let deco: Decoration;
    if (isImageFilename(target)) {
      const rel = resolveAttachment(target);
      if (rel !== null) {
        deco = Decoration.replace({ widget: new ImageEmbedWidget(rel, sizePx) });
      } else {
        deco = Decoration.replace({ widget: new BrokenEmbedWidget(target) });
      }
    } else {
      // Note embed. We intentionally ignore the #heading capture for now and
      // render the entire target note; heading slicing is a follow-up.
      const rel = resolveTarget(target);
      if (rel !== null) {
        const cached = noteContentCache.get(rel);
        if (cached === undefined) {
          scheduleNoteFetch(view, rel);
          // Show a muted placeholder while the fetch is in flight so the UI
          // doesn't flash with a stale version of the target note.
          deco = Decoration.replace({ widget: new NoteEmbedWidget(rel, "…") });
        } else {
          deco = Decoration.replace({ widget: new NoteEmbedWidget(rel, cached) });
        }
      } else {
        deco = Decoration.replace({ widget: new BrokenEmbedWidget(target) });
      }
    }

    matches.push({ from, to, decoration: deco });
  }

  // Markdown-form images: ![alt](path)
  MD_IMAGE_RE.lastIndex = 0;
  while ((m = MD_IMAGE_RE.exec(text)) !== null) {
    const rawPath = m[1];
    if (rawPath === undefined) continue;
    const from = m.index;
    const to = from + m[0].length;

    if (isInsideCodeBlock(view.state, from)) continue;
    if (head >= from && head <= to) continue;

    // Skip remote URLs — out of scope for this PR; the browser will fail the
    // request under the CSP and the user sees a broken <img>. Intentional.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith("//")) {
      continue;
    }

    let decoded: string;
    try {
      decoded = decodeURI(rawPath);
    } catch {
      decoded = rawPath;
    }
    // The markdown form may carry a folder prefix; we resolve by basename via
    // the attachment map so old `![](attachments/foo.png)` content still works
    // even if the image now lives elsewhere.
    const slashIdx = decoded.lastIndexOf("/");
    const basename = slashIdx === -1 ? decoded : decoded.slice(slashIdx + 1);
    const rel = resolveAttachment(basename);
    if (rel === null) continue; // markdown form has no placeholder — plain broken <img> if the path is wrong
    matches.push({
      from,
      to,
      decoration: Decoration.replace({ widget: new ImageEmbedWidget(rel, null) }),
    });
  }

  matches.sort((a, b) => a.from - b.from || a.to - b.to);

  // Drop overlapping ranges — a match containing another is already rare since
  // the regexes are non-greedy, but the builder requires strictly increasing
  // endpoints so we defend here instead of crashing.
  let lastTo = -1;
  for (const r of matches) {
    if (r.from < lastTo) continue;
    builder.add(r.from, r.to, r.decoration);
    lastTo = r.to;
  }

  return builder.finish();
}

// ── ViewPlugin ─────────────────────────────────────────────────────────────────

export const embedPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      // Clear caches so stale content from a previous vault does not leak into
      // the freshly-mounted view. Cheap because the caches are module-level.
      noteContentCache.clear();
      this.decorations = buildDecorations(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        // Doc-change events invalidate cached note content — rebuilding is
        // how we learn that the target note itself was edited via a different
        // open tab. Clearing the cache here is the simplest correct move.
        if (u.docChanged) {
          noteContentCache.clear();
        }
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Test-only hook: clear both caches so unit tests start from a clean slate.
 * Not part of the public API.
 */
export function __resetEmbedCachesForTests(): void {
  noteContentCache.clear();
  noteFetchInFlight.clear();
}
