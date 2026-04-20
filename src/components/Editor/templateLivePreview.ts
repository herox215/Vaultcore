// Live rendering of `{{ ... }}` template expressions inside the editor (#283).
//
// Replaces each matched `{{expr}}` range with a widget showing the evaluated
// value. The source text is revealed again whenever the selection overlaps
// the range, so the user can edit the expression — same pattern as
// livePreview.ts uses for markdown markup.
//
// Re-computation triggers:
//   - docChanged / viewportChanged / selectionSet  (CM6 native)
//   - vault store subscriptions (vault / tags / bookmarks)  → refreshEffect
//
// Errors (parse / unknown identifier / runtime) leave the source text as-is
// instead of replacing with "{{!err: ...}}" — the inline error rendering
// lives in templateSubstitution for the one-shot insertion path. For the
// live overlay, dropping the decoration is visually cleaner (user sees
// their in-progress typing, not an error chip on every keystroke).

import {
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { get } from "svelte/store";

import { evaluateProgram } from "../../lib/templateProgram";
import { currentVaultRoot } from "../../lib/vaultApiStoreBridge";
import { vaultStore } from "../../store/vaultStore";
import { tagsStore } from "../../store/tagsStore";
import { bookmarksStore } from "../../store/bookmarksStore";
import { editorStore } from "../../store/editorStore";
import { resolveTarget, stripKnownExt } from "./wikiLink";

const refreshEffect = StateEffect.define<void>();

// `[[target]]` or `[[target|alias]]`. Matches the shape wikiLink.ts uses for
// real doc links — rendered expression output gets the same treatment so
// `{{ ...select(n => "[[" + n.title + "]]")... }}` produces clickable links.
const WIKI_LINK_IN_RENDER_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;

class RenderedValueWidget extends WidgetType {
  constructor(readonly value: string) { super(); }
  override eq(other: WidgetType): boolean {
    return other instanceof RenderedValueWidget && other.value === this.value;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "vc-template-rendered";
    // `pre-wrap` so multi-line output from `.join("\n")` actually breaks
    // across lines inside the widget — default `normal` collapses \n to a
    // single space, which would flatten bulleted / tabular renders.
    el.style.whiteSpace = "pre-wrap";
    appendValueWithWikiLinks(el, this.value);
    return el;
  }
  override ignoreEvent(): boolean { return false; }
}

// Walks the rendered string and appends text nodes for plain runs and
// anchor-style `<span>` elements for every `[[target(|alias)?]]` match.
//
// The anchor carries the same `data-wiki-target` / `data-wiki-resolved`
// attributes the wikiLinkPlugin produces on real doc links, so its mousedown
// handler (registered on the EditorView) picks up clicks inside this widget
// and dispatches the shared `wiki-link-click` CustomEvent — EditorPane's
// existing listener then navigates. Zero new plumbing.
function appendValueWithWikiLinks(parent: HTMLElement, value: string): void {
  let cursor = 0;
  WIKI_LINK_IN_RENDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_IN_RENDER_RE.exec(value)) !== null) {
    if (m.index > cursor) {
      parent.appendChild(document.createTextNode(value.slice(cursor, m.index)));
    }
    const rawTarget = m[1]!;
    const alias = m[2];
    const stem = stripKnownExt(rawTarget);
    const resolved = resolveTarget(rawTarget) !== null;
    const link = document.createElement("span");
    link.className = resolved ? "cm-wikilink-resolved" : "cm-wikilink-unresolved";
    link.setAttribute("data-wiki-target", stem);
    link.setAttribute("data-wiki-resolved", resolved ? "true" : "false");
    link.textContent = alias !== undefined ? alias : rawTarget;
    parent.appendChild(link);
    cursor = m.index + m[0].length;
  }
  if (cursor < value.length) {
    parent.appendChild(document.createTextNode(value.slice(cursor)));
  }
}

const EXPR_RE = /\{\{([^{}]+?)\}\}/g;

function formatDate(now: Date): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatTime(now: Date): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mi}`;
}

function activeTitle(): string {
  const ap = get(editorStore).activePath;
  if (!ap) return "";
  const name = ap.split("/").pop() ?? "";
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { from, to } = view.viewport;
  const sel = view.state.selection;
  const text = view.state.doc.sliceString(from, to);

  // Lazily built — avoids touching stores when no expressions are in view.
  let vaultRoot: ReturnType<typeof currentVaultRoot> | null = null;
  const now = new Date();

  EXPR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPR_RE.exec(text)) !== null) {
    const absFrom = from + m.index;
    const absTo = absFrom + m[0].length;

    // Keep the source visible while the user has a cursor/selection
    // overlapping this range — same UX as markdown markup in livePreview.
    const overlap = sel.ranges.some(
      (r) => !(r.to < absFrom || r.from > absTo),
    );
    if (overlap) continue;

    const body = m[1]!;
    let rendered: string;
    try {
      if (vaultRoot === null) vaultRoot = currentVaultRoot();
      rendered = evaluateProgram(body, {
        vault: vaultRoot,
        date: formatDate(now),
        time: formatTime(now),
        title: activeTitle(),
      });
    } catch {
      continue;
    }
    // Drop the decoration when nothing evaluated successfully — otherwise
    // a single-segment failure would show an empty widget in place of the
    // source text, which is worse than leaving the source visible.
    if (rendered === "") continue;

    builder.add(
      absFrom,
      absTo,
      Decoration.replace({ widget: new RenderedValueWidget(rendered) }),
    );
  }

  return builder.finish();
}

export const templateLivePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private readonly unsubs: Array<() => void> = [];

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);

      // svelte `subscribe` invokes the callback synchronously with the
      // current value, so the `ready` latch swallows those initial calls
      // and avoids dispatching during plugin construction.
      let ready = false;
      const trigger = (): void => {
        if (!ready) return;
        view.dispatch({ effects: refreshEffect.of(undefined) });
      };
      this.unsubs.push(
        vaultStore.subscribe(trigger),
        tagsStore.subscribe(trigger),
        bookmarksStore.subscribe(trigger),
      );
      ready = true;
    }

    update(update: ViewUpdate): void {
      const forced = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshEffect)),
      );
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        forced
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }

    destroy(): void {
      for (const u of this.unsubs) u();
    }
  },
  { decorations: (v) => v.decorations },
);
