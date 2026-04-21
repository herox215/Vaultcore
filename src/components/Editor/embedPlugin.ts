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
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { mount, unmount } from "svelte";

import { resolveAttachment } from "./embeds";
import { resolveTarget } from "./wikiLink";
import {
  findTemplateExprRanges,
  isInsideTemplateExpr,
} from "./templateExprRanges";
import { vaultStore } from "../../store/vaultStore";
import { tabStore } from "../../store/tabStore";
import { readFile } from "../../ipc/commands";
import { listenFileChange } from "../../ipc/events";
import {
  readCached as readCachedNote,
  requestLoad as requestLoadNote,
  noteContentCacheVersion,
} from "../../lib/noteContentCache";
import { toVaultRel as toVaultRelHelper, absFromRel as absFromRelHelper } from "../../lib/vaultPath";
import { parseCanvas } from "../../lib/canvas/parse";
import type { CanvasNode } from "../../lib/canvas/types";
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from "../../lib/canvas/types";
import CanvasRenderer from "../Canvas/CanvasRenderer.svelte";

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

// ── Cache for canvas-embed content ────────────────────────────────────────────
//
// Note-embed content moved to `src/lib/noteContentCache.ts` (#319) so the
// template expression path (`n.content`) and the embed path share a single
// source of truth. Canvas JSON keeps its own cache here — it's only consumed
// by this plugin, not by the vault API.

/**
 * Canvas embeds (#147) share the same caching contract as note embeds (#27):
 * we fetch the raw .canvas JSON once, cache by vault-relative path, and
 * invalidate selectively from the same two subscriptions. #154 added the
 * canvas side to both invalidation hooks so changes to an embedded canvas
 * — whether from CanvasView autosave (internal) or an external editor —
 * refresh the inline SVG preview without reopening the host note.
 */
const canvasContentCache: Map<string, string> = new Map();
const canvasFetchInFlight: Set<string> = new Set();

/**
 * Every `embedPlugin` instance registers its view here on construction and
 * deregisters on destroy. External cache invalidators (file-change watcher,
 * tabStore subscribe) call `kickAllEmbedViews()` to force a fresh
 * `buildDecorations` pass on every mounted editor — otherwise the widget
 * never re-renders until the user types, and the new content stays invisible.
 */
const activeEmbedViews: Set<EditorView> = new Set();

/**
 * Tag transaction used to force an embed decoration rebuild without touching
 * the document or selection. Dispatching one `effects: [embedRefreshEffect.of()]`
 * still flows through `update()` like any other transaction — but a bare
 * `effects: []` would set none of the `docChanged`/`viewportChanged`/
 * `selectionSet` flags and our update guard would skip the rebuild.
 */
const embedRefreshEffect = StateEffect.define<void>();

function kickAllEmbedViews(): void {
  for (const v of Array.from(activeEmbedViews)) {
    if (v.dom.isConnected) {
      v.dispatch({ effects: embedRefreshEffect.of(undefined) });
    } else {
      activeEmbedViews.delete(v);
    }
  }
}

/**
 * Convert an absolute path to a vault-relative forward-slash path, or return
 * null when the path is outside the vault (or no vault is open). Thin
 * wrapper around the shared helper so all call-sites here stay terse.
 */
function toVaultRel(absPath: string): string | null {
  return toVaultRelHelper(absPath, get(vaultStore).currentPath ?? null);
}

// ── Canvas-cache invalidation: external file changes ─────────────────────────
//
// Note-content invalidation lives in `noteContentCache.ts` now. This handler
// keeps the canvas-specific portion of the old behaviour in place: external
// watcher events (Finder rename, shell `cp`, other editors) drop the cached
// JSON for the affected path and kick mounted views.
//
// Guarded try/catch because the subscription is module-level and the test
// environment has no Tauri IPC — a synchronous throw here would break imports.
try {
  void listenFileChange((payload) => {
    let changed = false;
    const rel = toVaultRel(payload.path);
    if (rel !== null && canvasContentCache.delete(rel)) changed = true;
    if (payload.new_path) {
      const newRel = toVaultRel(payload.new_path);
      if (newRel !== null && canvasContentCache.delete(newRel)) changed = true;
    }
    if (changed) kickAllEmbedViews();
  }).catch(() => {
    /* Tauri not initialized — tests run without the IPC backend. */
  });
} catch {
  /* same reason — swallow so the module still loads under vitest. */
}

// ── Canvas-cache invalidation: internal auto-saves via other tabs ────────────
//
// Mirror of the original snapshot-diff pattern (#154). Note-content writes
// fire the same snapshot change but are now handled in noteContentCache.ts;
// this handler only touches the canvas-JSON side.
const lastSavedCanvasByTabId: Map<string, string> = new Map();
tabStore.subscribe((state) => {
  let changed = false;
  for (const tab of state.tabs) {
    const prev = lastSavedCanvasByTabId.get(tab.id);
    if (prev !== tab.lastSavedContent) {
      lastSavedCanvasByTabId.set(tab.id, tab.lastSavedContent);
      const rel = toVaultRel(tab.filePath);
      if (rel !== null && canvasContentCache.delete(rel)) changed = true;
    }
  }
  const liveIds = new Set(state.tabs.map((t) => t.id));
  for (const id of Array.from(lastSavedCanvasByTabId.keys())) {
    if (!liveIds.has(id)) lastSavedCanvasByTabId.delete(id);
  }
  if (changed) kickAllEmbedViews();
});

// #319: the shared note-content cache lives in its own module. Subscribe to
// its version store so embed decorations refresh when a background fetch
// lands — same UX as the legacy per-view dispatch had. Svelte stores fire
// synchronously with the current value on subscribe; a `ready` latch
// swallows that initial call so we don't kick on module import.
let noteCacheReady = false;
noteContentCacheVersion.subscribe(() => {
  if (noteCacheReady) kickAllEmbedViews();
});
noteCacheReady = true;

/**
 * #154 — mirror of scheduleNoteFetch for `.canvas` embeds. Runs when
 * buildDecorations sees a cache miss; on completion we kick every mounted
 * editor so the SVG preview swaps in, not just the one that triggered the
 * fetch (a note can be open in both panes simultaneously).
 */
function scheduleCanvasFetch(view: EditorView, relPath: string): void {
  if (canvasContentCache.has(relPath) || canvasFetchInFlight.has(relPath)) return;
  const abs = absFromRel(relPath);
  if (abs === null) return;
  canvasFetchInFlight.add(relPath);
  void readFile(abs)
    .then((content) => {
      canvasContentCache.set(relPath, content);
    })
    .catch(() => {
      canvasContentCache.set(relPath, "");
    })
    .finally(() => {
      canvasFetchInFlight.delete(relPath);
      // Refresh every mounted editor (the same embed may be open in both
      // panes). kickAllEmbedViews dispatches the refresh-effect transaction
      // that the ViewPlugin update() recognises.
      kickAllEmbedViews();
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
  return absFromRelHelper(relPath, get(vaultStore).currentPath ?? null);
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
 * #147 / #156 — inline read-only mini-canvas for `![[mycanvas]]`. Mounts
 * the shared `CanvasRenderer` with `interactive={false}` so nodes render
 * with full HTML (markdown, file previews, link cards, group labels) and
 * edges keep their SVG bezier/arrowhead styling — pixel-identical to the
 * main CanvasView. Clicking anywhere opens the full canvas viewer via the
 * standard tabStore path.
 */
class CanvasEmbedWidget extends WidgetType {
  /**
   * `content` is the raw canvas JSON or `null` while the fetch is still
   * in flight. Bundling content into the widget (instead of reading it at
   * toDOM time) lets `eq()` compare-by-value so CM6 replaces the widget
   * when the source canvas changes — the root-cause of #154.
   */
  constructor(
    readonly relPath: string,
    readonly widthPx: number | null,
    readonly content: string | null,
  ) {
    super();
  }

  eq(other: CanvasEmbedWidget): boolean {
    return (
      this.relPath === other.relPath &&
      this.widthPx === other.widthPx &&
      this.content === other.content
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed-canvas";
    wrap.setAttribute("data-embed-path", this.relPath);
    wrap.setAttribute("role", "button");
    wrap.setAttribute("tabindex", "0");
    wrap.title = `Open ${this.relPath}`;
    const widthPx = this.widthPx ?? CANVAS_EMBED_DEFAULT_WIDTH;
    wrap.style.width = `${widthPx}px`;

    const body = document.createElement("div");
    body.className = "cm-embed-canvas-body";
    wrap.appendChild(body);

    if (this.content === null) {
      body.textContent = "…";
    } else {
      renderCanvasEmbedBody(body, this.content, widthPx, wrap);
    }

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

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    // Tear down the Svelte renderer instance — without this, every embed
    // replacement would leak reactive state until the view is destroyed.
    const component = (dom as unknown as { _vcRenderer?: unknown })._vcRenderer;
    if (component) {
      try {
        unmount(component);
      } catch {
        /* already unmounted */
      }
      (dom as unknown as { _vcRenderer?: unknown })._vcRenderer = undefined;
    }
  }

  ignoreEvent(event: Event): boolean {
    // Let click + keydown through to our own listener so the embed is
    // actionable even though CM6 otherwise swallows widget events.
    return !(event.type === "click" || event.type === "keydown");
  }
}

const CANVAS_EMBED_DEFAULT_WIDTH = 600;
const CANVAS_EMBED_MAX_HEIGHT = 420;
const CANVAS_EMBED_MIN_HEIGHT = 80;
const CANVAS_EMBED_PADDING = 24;

type EmbedCamera = { camX: number; camY: number; zoom: number; heightPx: number };

// #158 — fit-contain camera: scale so the padded bbox fits inside both the
// requested width and the max embed height, then center horizontally when
// the height constraint wins. Returns null for empty canvases.
function computeEmbedCamera(nodes: CanvasNode[], widthPx: number): EmbedCamera | null {
  if (nodes.length === 0) return null;
  const bbox = computeCanvasBBox(nodes);
  const pad = CANVAS_EMBED_PADDING;
  const bboxW = bbox.maxX - bbox.minX + pad * 2;
  const bboxH = bbox.maxY - bbox.minY + pad * 2;
  const zoomW = widthPx / bboxW;
  const zoomH = CANVAS_EMBED_MAX_HEIGHT / bboxH;
  const zoom = Math.min(zoomW, zoomH);
  const contentW = bboxW * zoom;
  const contentH = bboxH * zoom;
  const offsetX = Math.max(0, (widthPx - contentW) / 2);
  const camX = -(bbox.minX - pad) * zoom + offsetX;
  const camY = -(bbox.minY - pad) * zoom;
  const heightPx = Math.max(CANVAS_EMBED_MIN_HEIGHT, contentH);
  return { camX, camY, zoom, heightPx };
}

/**
 * Populate the embed body by mounting CanvasRenderer in read-only mode.
 * The bounding box of all nodes drives a fit-contain camera so the whole
 * canvas is always visible with a margin on every side (#158) — we never
 * crop; tall canvases scale down instead of being clipped.
 */
function renderCanvasEmbedBody(
  body: HTMLElement,
  rawJson: string,
  widthPx: number,
  wrap: HTMLElement,
): void {
  let doc;
  try {
    doc = parseCanvas(rawJson);
  } catch {
    body.textContent = "\u26A0 invalid canvas file";
    return;
  }
  if (doc.nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cm-embed-canvas-empty";
    empty.textContent = "(empty canvas)";
    body.appendChild(empty);
    return;
  }

  const cam = computeEmbedCamera(doc.nodes, widthPx)!;
  body.style.position = "relative";
  body.style.overflow = "hidden";
  body.style.height = `${cam.heightPx}px`;

  const vaultPath = get(vaultStore).currentPath ?? null;
  const component = mount(CanvasRenderer, {
    target: body,
    props: {
      doc,
      camX: cam.camX,
      camY: cam.camY,
      zoom: cam.zoom,
      vaultPath,
      interactive: false,
    },
  });
  // Stash the handle on the wrapper so CanvasEmbedWidget.destroy() can
  // unmount the component when CM6 tears the widget down.
  (wrap as unknown as { _vcRenderer?: unknown })._vcRenderer = component;
}

function computeCanvasBBox(nodes: CanvasNode[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
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
  return { minX, minY, maxX, maxY };
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
  const exprRanges = findTemplateExprRanges(text);

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
    if (isInsideTemplateExpr(exprRanges, from, to)) continue;

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
          // #154 — bundle the cached JSON into the widget so edits to the
          // source canvas produce a value-different widget and CM6 swaps
          // the DOM; a miss schedules a fetch with a null-content placeholder.
          const cachedCanvas = canvasContentCache.get(rel);
          if (cachedCanvas === undefined) {
            scheduleCanvasFetch(view, rel);
            deco = Decoration.replace({ widget: new CanvasEmbedWidget(rel, sizePx, null) });
          } else {
            deco = Decoration.replace({ widget: new CanvasEmbedWidget(rel, sizePx, cachedCanvas) });
          }
        } else {
          // #319: note-content cache is shared with the vault API.
          const cached = readCachedNote(rel);
          if (cached === null) {
            requestLoadNote(rel);
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
    if (isInsideTemplateExpr(exprRanges, from, to)) continue;
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
    private view: EditorView;

    constructor(view: EditorView) {
      // Canvas cache clears on mount so stale JSON from a previous vault
      // doesn't leak into the freshly-mounted view. The note-content cache
      // is managed by `noteContentCache.ts` and already clears on vault
      // switch via its own vaultStore subscription.
      canvasContentCache.clear();
      this.view = view;
      // #154: register so module-level invalidation hooks can kick a rebuild.
      activeEmbedViews.add(view);
      this.decorations = buildDecorations(view);
    }

    update(u: ViewUpdate) {
      const refreshRequested = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(embedRefreshEffect)),
      );
      if (u.docChanged || u.viewportChanged || u.selectionSet || refreshRequested) {
        this.decorations = buildDecorations(u.view);
      }
    }

    destroy() {
      activeEmbedViews.delete(this.view);
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Test-only hook: clear the canvas cache so unit tests start from a clean
 * slate. The note-content cache lives in its own module now — tests that
 * exercise that surface should reset it via `__cacheForTests.reset()`.
 * Not part of the public API.
 */
export function __resetEmbedCachesForTests(): void {
  canvasContentCache.clear();
}

/** Test-only: compute the fit-contain camera for a raw canvas JSON (#156/#158). */
export function __computeEmbedCameraForTests(
  rawJson: string,
  widthPx: number,
): EmbedCamera | null {
  const doc = parseCanvas(rawJson);
  return computeEmbedCamera(doc.nodes, widthPx);
}

/** Test-only: expose the canvas-content cache for cache-invalidation tests (#154). */
export const __canvasCacheForTests = {
  get: (rel: string): string | undefined => canvasContentCache.get(rel),
  set: (rel: string, content: string): void => {
    canvasContentCache.set(rel, content);
  },
  has: (rel: string): boolean => canvasContentCache.has(rel),
};

/** Test-only: value-compare two CanvasEmbedWidget instances through eq(). */
export function __canvasWidgetEqForTests(
  a: { relPath: string; widthPx: number | null; content: string | null },
  b: { relPath: string; widthPx: number | null; content: string | null },
): boolean {
  const wa = new CanvasEmbedWidget(a.relPath, a.widthPx, a.content);
  const wb = new CanvasEmbedWidget(b.relPath, b.widthPx, b.content);
  return wa.eq(wb);
}
