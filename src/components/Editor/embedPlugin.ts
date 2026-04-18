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
import { tabStore } from "../../store/tabStore";
import { readFile } from "../../ipc/commands";
import { listenFileChange } from "../../ipc/events";
import { parseCanvas } from "../../lib/canvas/parse";
import type { CanvasNode } from "../../lib/canvas/types";
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from "../../lib/canvas/types";

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
 * Vault-relative path → file content. Entries are invalidated selectively by
 * two module-level subscriptions installed at import time:
 *   - `listenFileChange` for external modifications the watcher sees
 *   - `tabStore.subscribe` for internal auto-saves (which suppress the watcher
 *     via write_ignore, so we'd otherwise miss them)
 * Previously the cache was cleared on every local `docChanged`, which caused
 * the `…` placeholder to flash on every keystroke — see #27.
 */
const noteContentCache: Map<string, string> = new Map();
/**
 * Paths whose `readFile` call is already in flight, used to suppress duplicate
 * IPC requests from back-to-back plugin rebuilds.
 */
const noteFetchInFlight: Set<string> = new Set();

/**
 * Convert an absolute path to a vault-relative forward-slash path, or return
 * null when the path is outside the vault (or no vault is open).
 */
function toVaultRel(absPath: string): string | null {
  const vault = get(vaultStore).currentPath;
  if (!vault) return null;
  const absFwd = absPath.replace(/\\/g, "/");
  const vaultFwd = vault.replace(/\\/g, "/").replace(/\/$/, "");
  if (absFwd === vaultFwd) return "";
  if (!absFwd.startsWith(vaultFwd + "/")) return null;
  return absFwd.slice(vaultFwd.length + 1);
}

// ── Cache invalidation: external file changes ─────────────────────────────────
//
// The watcher only fires for modifications NOT initiated by our own IPC writes
// (write_ignore suppresses self-writes). That means this catches edits made by
// tools outside the app — Finder rename, shell `cp`, other editors. Internal
// auto-saves are handled by the tabStore subscription below.
//
// Guarded try/catch because the subscription is module-level and the test
// environment has no Tauri IPC — a synchronous throw here would break imports.
try {
  void listenFileChange((payload) => {
    const rel = toVaultRel(payload.path);
    if (rel !== null) noteContentCache.delete(rel);
    if (payload.new_path) {
      const newRel = toVaultRel(payload.new_path);
      if (newRel !== null) noteContentCache.delete(newRel);
    }
  }).catch(() => {
    /* Tauri not initialized — tests run without the IPC backend. */
  });
} catch {
  /* same reason — swallow so the module still loads under vitest. */
}

// ── Cache invalidation: internal auto-saves via other tabs ────────────────────
//
// tabStore.setLastSavedContent fires after writeFile returns successfully. We
// snapshot each tab's lastSavedContent the first time we see it and diff on
// subsequent store emissions — when the snapshot changes, the file was just
// saved (by any tab, including ones in other panes), so invalidate its cache
// entry. This lets the next embed rebuild re-fetch the fresh content.
const lastSavedByTabId: Map<string, string> = new Map();
tabStore.subscribe((state) => {
  for (const tab of state.tabs) {
    const prev = lastSavedByTabId.get(tab.id);
    if (prev !== tab.lastSavedContent) {
      lastSavedByTabId.set(tab.id, tab.lastSavedContent);
      const rel = toVaultRel(tab.filePath);
      if (rel !== null) noteContentCache.delete(rel);
    }
  }
  // Clean up snapshots for tabs that have closed so the map doesn't grow.
  const liveIds = new Set(state.tabs.map((t) => t.id));
  for (const id of Array.from(lastSavedByTabId.keys())) {
    if (!liveIds.has(id)) lastSavedByTabId.delete(id);
  }
});

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

/**
 * #147 — inline read-only mini-canvas for `![[mycanvas]]`. Renders node
 * rectangles and edges as a single SVG that auto-fits all nodes into the
 * widget's box. Clicking anywhere opens the full canvas viewer via the
 * standard tabStore path.
 */
class CanvasEmbedWidget extends WidgetType {
  constructor(readonly relPath: string, readonly widthPx: number | null) {
    super();
  }

  eq(other: CanvasEmbedWidget): boolean {
    return this.relPath === other.relPath && this.widthPx === other.widthPx;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed-canvas";
    wrap.setAttribute("data-embed-path", this.relPath);
    wrap.setAttribute("role", "button");
    wrap.setAttribute("tabindex", "0");
    wrap.title = `Open ${this.relPath}`;
    if (this.widthPx !== null) {
      wrap.style.width = `${this.widthPx}px`;
    }

    const content = document.createElement("div");
    content.className = "cm-embed-canvas-body";
    content.textContent = "…";
    wrap.appendChild(content);

    const abs = absFromRel(this.relPath);
    const openCanvas = (): void => {
      if (!abs) return;
      tabStore.openFileTab(abs, "canvas");
    };
    wrap.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCanvas();
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCanvas();
      }
    });

    const cached = canvasContentCache.get(this.relPath);
    if (cached !== undefined) {
      renderCanvasPreviewInto(content, cached);
    } else if (abs) {
      readFile(abs)
        .then((src) => {
          canvasContentCache.set(this.relPath, src);
          renderCanvasPreviewInto(content, src);
        })
        .catch(() => {
          content.textContent = `\u26A0 cannot read: ${this.relPath}`;
        });
    }

    return wrap;
  }

  ignoreEvent(event: Event): boolean {
    // Let click + keydown through to our own listener so the embed is
    // actionable even though CM6 otherwise swallows widget events.
    return !(event.type === "click" || event.type === "keydown");
  }
}

/** Cache the raw canvas JSON so re-renders don't re-hit readFile. */
const canvasContentCache: Map<string, string> = new Map();

function renderCanvasPreviewInto(el: HTMLElement, rawJson: string): void {
  el.textContent = "";
  let doc;
  try {
    doc = parseCanvas(rawJson);
  } catch {
    el.textContent = "\u26A0 invalid canvas file";
    return;
  }
  const nodes = doc.nodes;
  if (nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cm-embed-canvas-empty";
    empty.textContent = "(empty canvas)";
    el.appendChild(empty);
    return;
  }

  // Compute bounding box including default sizes for nodes missing width/height.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const w = n.width || DEFAULT_NODE_WIDTH;
    const h = n.height || DEFAULT_NODE_HEIGHT;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + w > maxX) maxX = n.x + w;
    if (n.y + h > maxY) maxY = n.y + h;
  }
  const pad = 20;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = maxX - minX + pad * 2;
  const vbH = maxY - minY + pad * 2;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("class", "cm-embed-canvas-svg");

  // Edges first, so nodes paint over.
  const nodeMap = new Map<string, CanvasNode>(nodes.map((n) => [n.id, n]));
  for (const edge of doc.edges) {
    const a = nodeMap.get(edge.fromNode);
    const b = nodeMap.get(edge.toNode);
    if (!a || !b) continue;
    const ax = a.x + (a.width || DEFAULT_NODE_WIDTH) / 2;
    const ay = a.y + (a.height || DEFAULT_NODE_HEIGHT) / 2;
    const bx = b.x + (b.width || DEFAULT_NODE_WIDTH) / 2;
    const by = b.y + (b.height || DEFAULT_NODE_HEIGHT) / 2;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(ax));
    line.setAttribute("y1", String(ay));
    line.setAttribute("x2", String(bx));
    line.setAttribute("y2", String(by));
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("opacity", "0.5");
    svg.appendChild(line);
  }

  for (const n of nodes) {
    const w = n.width || DEFAULT_NODE_WIDTH;
    const h = n.height || DEFAULT_NODE_HEIGHT;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(n.x));
    rect.setAttribute("y", String(n.y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", "6");
    rect.setAttribute("ry", "6");
    rect.setAttribute("fill", "var(--vc-bg-secondary, #f5f5f5)");
    rect.setAttribute("stroke", "currentColor");
    rect.setAttribute("stroke-width", "1.5");
    svg.appendChild(rect);
    // Lightweight label: for text nodes we preview the first line; for other
    // nodes we show the type so the reader sees the structure at a glance.
    const label = nodeLabel(n);
    if (label) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(n.x + 8));
      text.setAttribute("y", String(n.y + 20));
      text.setAttribute("font-size", "14");
      text.setAttribute("fill", "currentColor");
      text.textContent = label;
      svg.appendChild(text);
    }
  }

  el.appendChild(svg);
}

function nodeLabel(n: CanvasNode): string {
  // `CanvasUnknownNode` overlaps every other variant on the `type` discriminant,
  // so read optional fields through a loose record to keep the union-narrowing
  // from collapsing into the fallback branch.
  const any = n as unknown as Record<string, unknown>;
  if (n.type === "text") {
    const raw = typeof any["text"] === "string" ? (any["text"] as string) : "";
    const firstLine = raw.split("\n", 1)[0] ?? "";
    return firstLine.length > 40 ? `${firstLine.slice(0, 37)}…` : firstLine;
  }
  if (n.type === "file") return typeof any["file"] === "string" ? (any["file"] as string) : "(file)";
  if (n.type === "link") return typeof any["url"] === "string" ? (any["url"] as string) : "(link)";
  if (n.type === "group") {
    return typeof any["label"] === "string" ? (any["label"] as string) : "(group)";
  }
  return n.type;
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
      // Note / canvas embed. We intentionally ignore the #heading capture for
      // now and render the entire target; heading slicing is a follow-up.
      const rel = resolveTarget(target);
      if (rel !== null) {
        if (rel.endsWith(".canvas")) {
          // #147 — route canvas targets through the SVG preview widget.
          deco = Decoration.replace({ widget: new CanvasEmbedWidget(rel, sizePx) });
        } else {
          const cached = noteContentCache.get(rel);
          if (cached === undefined) {
            scheduleNoteFetch(view, rel);
            // Show a muted placeholder while the fetch is in flight so the UI
            // doesn't flash with a stale version of the target note.
            deco = Decoration.replace({ widget: new NoteEmbedWidget(rel, "…") });
          } else {
            deco = Decoration.replace({ widget: new NoteEmbedWidget(rel, cached) });
          }
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
  canvasContentCache.clear();
}

/** Test-only: render an SVG preview for a raw canvas JSON string into `el`. */
export function __renderCanvasPreviewForTests(el: HTMLElement, rawJson: string): void {
  renderCanvasPreviewInto(el, rawJson);
}
