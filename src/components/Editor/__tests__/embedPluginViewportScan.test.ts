// Regression tests for issue #247 (viewport-bounded scan in embedPlugin).
//
// Before the fix, `buildDecorations` called `view.state.doc.toString()` and
// ran both WIKI_EMBED_RE and MD_IMAGE_RE over the entire document on every
// docChanged / viewportChanged / selectionSet transaction — two full-doc
// regex passes on top of the full-doc allocation. Same hot path as
// wikiLink.ts; same fix shape.
//
// The fix slices only `view.viewport.from..view.viewport.to` (± 512 bytes
// widen margin so embeds that straddle the viewport boundary still get
// decorated) and offsets every absolute position by the widened-window
// `from`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";

// Stub the IPC layer — the plugin subscribes to listenFileChange + readFile
// at import time, and neither is available in jsdom.
vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../../ipc/commands", () => ({
  readFile: vi.fn().mockResolvedValue(""),
}));

import { embedPlugin } from "../embedPlugin";
import { setResolvedAttachments } from "../embeds";
import { setResolvedLinks } from "../wikiLink";

function mount(doc: string, cursor = 0): { view: EditorView; parent: HTMLElement } {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [embedPlugin],
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ state, parent });
  return { view, parent };
}

function overrideViewport(view: EditorView, from: number, to: number): void {
  Object.defineProperty(view, "viewport", {
    value: { from, to },
    configurable: true,
  });
}

interface Deco {
  from: number;
  to: number;
}

function collectDecos(view: EditorView): Deco[] {
  const out: Deco[] = [];
  for (const plugin of (view as unknown as {
    plugins: Array<{ value?: { decorations?: unknown } }>;
  }).plugins) {
    const deco = plugin.value?.decorations;
    if (!deco) continue;
    const set = deco as ReturnType<typeof Decoration.none.update>;
    const iter = set.iter();
    while (iter.value) {
      out.push({ from: iter.from, to: iter.to });
      iter.next();
    }
  }
  return out;
}

describe("embedPlugin — viewport-bounded scan (#247)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setResolvedAttachments(new Map([["img.png", "images/img.png"]]));
    setResolvedLinks(new Map());
  });

  it("decorates a wiki-embed inside the viewport at the correct absolute offset", () => {
    const prefix = "a".repeat(1_000);
    const embed = "![[img.png|500]]";
    const suffix = "b".repeat(30_000);
    const doc = prefix + embed + suffix;
    const embedFrom = prefix.length;
    const embedTo = embedFrom + embed.length;

    const { view, parent } = mount(doc, 0);
    overrideViewport(view, 0, 5_000);
    view.dispatch({ selection: EditorSelection.cursor(0) });

    const decos = collectDecos(view);
    // The embed region must carry at least one decoration (the replace widget).
    const inEmbed = decos.filter((d) => d.from >= embedFrom && d.to <= embedTo);
    expect(inEmbed.length).toBeGreaterThan(0);
    // Exact-match assertion: the decoration spans the full embed.
    expect(inEmbed.some((d) => d.from === embedFrom && d.to === embedTo)).toBe(true);

    view.destroy();
    parent.remove();
  });

  it("does NOT decorate wiki-embeds far outside the viewport + widen margin", () => {
    // Load-bearing regression test. On main, the full-doc scan decorates
    // `![[img.png]]` at offset 30_000 even when the viewport is [0, 1_000].
    const filler = "x".repeat(30_000);
    const embed = "![[img.png|200]]";
    const tail = "y".repeat(10_000);
    const doc = filler + embed + tail;
    const embedFrom = filler.length;
    const embedTo = embedFrom + embed.length;

    const { view, parent } = mount(doc, 0);
    overrideViewport(view, 0, 1_000);
    view.dispatch({ selection: EditorSelection.cursor(500) });

    const decos = collectDecos(view);
    const overlapping = decos.filter(
      (d) => d.to > embedFrom && d.from < embedTo,
    );
    expect(overlapping).toEqual([]);

    view.destroy();
    parent.remove();
  });

  it("detects a wiki-embed whose sizing tail `|500]]` straddles the viewport end (widen works)", () => {
    // Opening `![[img.png` is inside the viewport but the `|500]]` tail sits
    // just past `viewport.to`. The 512-byte widen on the right margin must
    // recover the full match.
    const before = "p".repeat(1_000);
    const embed = "![[img.png|500]]"; // 16 chars
    const after = "s".repeat(3_000);
    const doc = before + embed + after;
    const embedFrom = before.length;
    const embedTo = embedFrom + embed.length;

    const { view, parent } = mount(doc, 0);
    // End the viewport inside the embed so `|500]]` is past viewport.to
    // but well inside the widen margin.
    const viewportFrom = 0;
    const viewportTo = embedFrom + 4; // 4 bytes in — the `|500]]` is past
    overrideViewport(view, viewportFrom, viewportTo);
    view.dispatch({ selection: EditorSelection.cursor(0) });

    const decos = collectDecos(view);
    const matching = decos.filter(
      (d) => d.from === embedFrom && d.to === embedTo,
    );
    expect(matching.length).toBeGreaterThan(0);

    view.destroy();
    parent.remove();
  });

  it("detects a markdown image `![alt](url)` straddling the viewport start (widen works)", () => {
    // Opening `![alt](` begins before the viewport; widen margin must reach
    // back and absolute-offset math must produce the correct doc coordinates.
    const lead = "z".repeat(2_000);
    const md = "![alt](images/img.png)";
    const trail = "w".repeat(3_000);
    const doc = lead + md + trail;
    const mdFrom = lead.length;
    const mdTo = mdFrom + md.length;

    const { view, parent } = mount(doc, 0);
    // Viewport starts mid-image so the opening `![alt](` is behind
    // viewport.from but inside the 512-byte widen.
    const viewportFrom = mdFrom + 5; // 5 bytes in → margin 5 < 512
    const viewportTo = viewportFrom + 1_000;
    overrideViewport(view, viewportFrom, viewportTo);
    view.dispatch({ selection: EditorSelection.cursor(viewportFrom + 100) });

    const decos = collectDecos(view);
    const matching = decos.filter(
      (d) => d.from === mdFrom && d.to === mdTo,
    );
    expect(matching.length).toBeGreaterThan(0);

    view.destroy();
    parent.remove();
  });
});
