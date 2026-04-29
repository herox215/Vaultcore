// Wiki-link CM6 ViewPlugin — Phase 4 Plan 02 / Issue #62 anchor support.
//
// Architecture:
//   - Module-level `resolvedLinks: Map<stem, relPath>` populated once per vault
//     open via EditorPane calling setResolvedLinks(await getResolvedLinks()).
//   - Module-level `resolvedAnchors: Map<relPath, AnchorKeySet>` (#62) added
//     alongside so block-ref / heading-ref decoration is also a sync Map.get().
//   - Every decoration + click lookup is a synchronous Map.get() — zero IPC
//     inside the CM6 render loop, zero IPC at click time.
//   - Click events are dispatched as CustomEvent("wiki-link-click") on the
//     EditorView DOM so the Svelte layer handles navigation without coupling
//     the CM6 extension to Svelte stores.
//
// Resolution model (#62):
//   "resolved"       — note exists, anchor (if any) matches.
//   "anchor-missing" — note exists, anchor does NOT match. Click opens note,
//                      Svelte side surfaces a toast.
//   "unresolved"     — note does not exist. Click creates the note.

import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import type { AnchorEntry, AnchorKeySet } from "../../types/links";
import { slugify } from "../../lib/headingSlug";
import {
  findTemplateExprRanges,
  isInsideTemplateExpr,
} from "../../lib/templateExprRanges";

const HIDE = Decoration.replace({});

// ── Wiki-link regex ────────────────────────────────────────────────────────────

/**
 * Matches `[[target]]`, `[[target|alias]]`, `[[target#H]]`, `[[target^id]]`,
 * and any `target` + heading + block + alias combination.
 *
 * Capture groups are intentionally NOT used for anchor splitting — the regex
 * captures the full target including any `#H` / `^id` suffix in group 1; the
 * runtime parser (`parseLinkTarget`) splits stem / heading / block-id with
 * the same precedence rule the rename-cascade regex uses on the Rust side.
 * Single-source-of-truth for the parsing rule lives in `parseLinkTarget`.
 */
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

// ── Resolution state ───────────────────────────────────────────────────────────

/**
 * Stem (lowercased) → vault-relative path. Populated by EditorPane on vault
 * open (and on every `resolvedLinksStore.requestReload()` after rename/move).
 */
let resolvedLinks: Map<string, string> = new Map();

/**
 * Vault-relative path → anchor table (#62). Populated alongside
 * `resolvedLinks` by EditorPane. Empty until `setResolvedAnchors` fires.
 */
let resolvedAnchors: Map<string, AnchorKeySet> = new Map();

export function setResolvedLinks(map: Map<string, string>): void {
  resolvedLinks = map;
}

/**
 * Replace the per-vault anchor map. Called by EditorPane right after
 * `setResolvedLinks` in `reloadResolvedLinks`.
 */
export function setResolvedAnchors(map: Map<string, AnchorKeySet>): void {
  resolvedAnchors = map;
}

/**
 * Parsed wiki-link suffix. Block-id wins when both `^` and `#` are present —
 * a malformed `[[Note#H^id]]` is treated as a block ref because Obsidian's
 * own parser anchors on the trailing `^id`. The exact precedence is locked
 * in by the test suite.
 */
export interface ParsedAnchor {
  kind: "block" | "heading";
  /** Lowercased for blocks, original case (slug-case folded) for headings. */
  value: string;
}

export interface ParsedTarget {
  stem: string;
  anchor: ParsedAnchor | null;
}

/**
 * Split a raw wiki-link target into `(stem, anchor?)`. Pure function — does
 * not consult any resolution map. Single source of truth for anchor-suffix
 * parsing on the frontend; the Rust side parses anchors at index time.
 */
export function parseLinkTarget(raw: string): ParsedTarget {
  const stripped = stripKnownExt(raw);
  // Block-id wins: scan for the LAST `^` and accept it only when the suffix
  // is a valid block-id ([A-Za-z0-9-]+) and contains no `#`. This means
  // `[[Note#H^id]]` resolves as `^id` (matches Rust-side block-id grammar).
  const caretIdx = stripped.lastIndexOf("^");
  if (caretIdx > 0) {
    const id = stripped.slice(caretIdx + 1);
    if (/^[A-Za-z0-9-]+$/.test(id)) {
      return { stem: stripped.slice(0, caretIdx), anchor: { kind: "block", value: id.toLowerCase() } };
    }
  }
  const hashIdx = stripped.indexOf("#");
  if (hashIdx > 0) {
    return {
      stem: stripped.slice(0, hashIdx),
      anchor: { kind: "heading", value: stripped.slice(hashIdx + 1) },
    };
  }
  return { stem: stripped, anchor: null };
}

/**
 * Synchronous lookup of `[[target]]` → vault-relative path. Strips any
 * `#H` / `^id` suffix before consulting the stem map so legacy callers that
 * pass the full link text still receive a match for the underlying note.
 */
export function resolveTarget(target: string): string | null {
  const { stem } = parseLinkTarget(target);
  return resolvedLinks.get(stem.toLowerCase()) ?? null;
}

export function stripKnownExt(target: string): string {
  if (target.endsWith(".md")) return target.slice(0, -3);
  if (target.endsWith(".canvas")) return target.slice(0, -7);
  return target;
}

/**
 * Look up the anchor entry for `(relPath, anchor)`, or `null` when the file
 * has no anchors registered or the anchor doesn't match.
 *
 * Block ids compare byte-for-byte against the lowercased value already
 * produced by `parseLinkTarget`. Heading lookups slugify the raw heading
 * text first so `[[Note#Multi Word Heading]]` matches the index-time slug
 * `multi-word-heading`. The slug algorithm is the same on both sides —
 * see `test-fixtures/slug_parity.json`.
 */
export function resolveAnchor(relPath: string, anchor: ParsedAnchor): AnchorEntry | null {
  const set = resolvedAnchors.get(relPath);
  if (!set) return null;
  if (anchor.kind === "block") {
    return set.blocks.find((b) => b.id === anchor.value) ?? null;
  }
  const targetSlug = slugify(anchor.value);
  return set.headings.find((h) => h.id === targetSlug) ?? null;
}

/** Three-valued resolution state for wiki-links carrying optional anchors (#62). */
export type LinkResolution = "resolved" | "anchor-missing" | "unresolved";

function resolveLink(parsed: ParsedTarget): { resolution: LinkResolution; relPath: string | null } {
  const relPath = resolvedLinks.get(parsed.stem.toLowerCase()) ?? null;
  if (relPath === null) {
    return { resolution: "unresolved", relPath: null };
  }
  if (parsed.anchor === null) {
    return { resolution: "resolved", relPath };
  }
  const anchor = resolveAnchor(relPath, parsed.anchor);
  return {
    resolution: anchor !== null ? "resolved" : "anchor-missing",
    relPath,
  };
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

// ── Decoration builder ─────────────────────────────────────────────────────────

interface WikiMatch {
  from: number;
  to: number;
  /** Stem (without anchor and without alias). */
  target: string;
  resolution: LinkResolution;
  /** Parsed anchor suffix or `null`. Carried so the click event can dispatch
   * navigation without re-parsing. */
  anchor: ParsedAnchor | null;
  aliasStart: number | null;
  aliasEnd: number | null;
}

interface DecoratedRange {
  from: number;
  to: number;
  decoration: Decoration;
}

const VIEWPORT_WIDEN_BYTES = 512;

function classFor(resolution: LinkResolution): string {
  switch (resolution) {
    case "resolved":
      return "cm-wikilink-resolved";
    case "anchor-missing":
      return "cm-wikilink-unresolved-anchor";
    case "unresolved":
      return "cm-wikilink-unresolved";
  }
}

function attrsFor(match: WikiMatch): Record<string, string> {
  const attrs: Record<string, string> = {
    "data-wiki-target": match.target,
    "data-wiki-resolved": match.resolution,
  };
  if (match.anchor) {
    attrs["data-wiki-anchor-kind"] = match.anchor.kind;
    attrs["data-wiki-anchor-value"] = match.anchor.value;
  }
  return attrs;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const state = view.state;
  const docLength = state.doc.length;

  const windowFrom = Math.max(0, view.viewport.from - VIEWPORT_WIDEN_BYTES);
  const windowTo = Math.min(docLength, view.viewport.to + VIEWPORT_WIDEN_BYTES);
  const text = state.sliceDoc(windowFrom, windowTo);
  const head = state.selection.main.head;
  const exprRanges = findTemplateExprRanges(text, windowFrom);

  const matches: WikiMatch[] = [];

  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(text)) !== null) {
    const rawTarget: string | undefined = m[1];
    if (rawTarget === undefined) continue;

    const from = windowFrom + m.index;
    const to = from + m[0].length;

    if (isInsideCodeBlock(state, from)) continue;
    if (isInsideTemplateExpr(exprRanges, from, to)) continue;

    const parsed = parseLinkTarget(rawTarget);
    const { resolution } = resolveLink(parsed);

    const aliasText = m[2];
    let aliasStart: number | null = null;
    let aliasEnd: number | null = null;
    if (aliasText !== undefined) {
      const pipePosInSlice = text.indexOf("|", m.index + 2);
      if (pipePosInSlice !== -1) {
        aliasStart = windowFrom + pipePosInSlice;
        aliasEnd = to - 2;
      }
    }

    matches.push({
      from,
      to,
      target: parsed.stem,
      resolution,
      anchor: parsed.anchor,
      aliasStart,
      aliasEnd,
    });
  }

  matches.sort((a, b) => a.from - b.from);

  const allRanges: DecoratedRange[] = [];

  for (const match of matches) {
    const cursorInLink = head >= match.from && head <= match.to;
    const cls = classFor(match.resolution);
    const attrs = attrsFor(match);

    if (cursorInLink) {
      allRanges.push({
        from: match.from,
        to: match.to,
        decoration: Decoration.mark({ class: cls, attributes: attrs }),
      });
    } else {
      allRanges.push({ from: match.from, to: match.from + 2, decoration: HIDE });
      allRanges.push({ from: match.to - 2, to: match.to, decoration: HIDE });

      if (match.aliasStart !== null && match.aliasEnd !== null) {
        allRanges.push({ from: match.aliasStart, to: match.aliasStart + 1, decoration: HIDE });
        const visibleFrom = match.aliasStart + 1;
        const visibleTo = match.aliasEnd;
        allRanges.push({
          from: visibleFrom,
          to: visibleTo,
          decoration: Decoration.mark({ class: cls, attributes: attrs }),
        });
      } else {
        const visibleFrom = match.from + 2;
        const visibleTo = match.to - 2;
        if (visibleFrom < visibleTo) {
          allRanges.push({
            from: visibleFrom,
            to: visibleTo,
            decoration: Decoration.mark({ class: cls, attributes: attrs }),
          });
        }
      }
    }
  }

  allRanges.sort((a, b) => a.from - b.from || a.to - b.to);

  for (const r of allRanges) {
    builder.add(r.from, r.to, r.decoration);
  }

  return builder.finish();
}

// ── ViewPlugin ─────────────────────────────────────────────────────────────────

/** Detail payload for the `wiki-link-click` CustomEvent. */
export interface WikiLinkClickDetail {
  /** Stem only — anchor / alias are stripped. */
  target: string;
  /** Three-valued resolution state. */
  resolution: LinkResolution;
  /** Anchor suffix (if any) — pre-parsed so the Svelte handler can route
   * straight to scroll-to-block / scroll-to-heading without reparsing. */
  anchor: ParsedAnchor | null;
}

export const wikiLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event: MouseEvent, view: EditorView) {
        const target = event.target as HTMLElement;
        const wikiTarget = target.closest("[data-wiki-target]");
        if (!wikiTarget) return false;

        const linkTarget = wikiTarget.getAttribute("data-wiki-target");
        if (!linkTarget) return false;
        const rawResolution = wikiTarget.getAttribute("data-wiki-resolved") ?? "unresolved";
        const resolution: LinkResolution =
          rawResolution === "resolved" || rawResolution === "anchor-missing"
            ? rawResolution
            : "unresolved";
        const kind = wikiTarget.getAttribute("data-wiki-anchor-kind");
        const value = wikiTarget.getAttribute("data-wiki-anchor-value");
        const anchor: ParsedAnchor | null =
          kind === "block" || kind === "heading"
            ? { kind, value: value ?? "" }
            : null;

        event.preventDefault();
        event.stopPropagation();

        const detail: WikiLinkClickDetail = { target: linkTarget, resolution, anchor };
        view.dom.dispatchEvent(
          new CustomEvent<WikiLinkClickDetail>("wiki-link-click", {
            bubbles: true,
            detail,
          }),
        );

        return true;
      },
    },
  },
);

// ── Refresh helper ─────────────────────────────────────────────────────────────

/**
 * Force decoration rebuild on all open EditorViews after `setResolvedLinks`
 * is called. Dispatches a no-op transaction to trigger `update()`.
 */
export function refreshWikiLinks(view: EditorView): void {
  view.dispatch({ effects: [] });
}
