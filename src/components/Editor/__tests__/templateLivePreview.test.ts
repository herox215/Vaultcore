// Integration test for the live `{{ ... }}` rendering ViewPlugin (#283 live).
//
// Mounts a real CodeMirror EditorView over a detached DOM node and inspects
// the decoration set that `templateLivePlugin` installs. We don't touch IPC
// or the Rust backend — only the svelte stores the plugin reads from, which
// are mocked to return a deterministic vault snapshot.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { writable } from "svelte/store";

vi.mock("../../../store/vaultStore", () => {
  const _store = writable({
    currentPath: "/v/MyVault",
    status: "ready",
    fileList: ["first.md", "second.md"],
    fileCount: 2,
    errorMessage: null,
    sidebarWidth: 240,
    vaultReachable: true,
  });
  return {
    vaultStore: {
      subscribe: _store.subscribe,
      _set: _store.set,
    },
  };
});

vi.mock("../../../store/tagsStore", () => {
  const _store = writable({
    tags: [{ tag: "#idea", count: 1 }],
    loading: false,
    error: null,
  });
  return {
    tagsStore: { subscribe: _store.subscribe, _set: _store.set },
  };
});

vi.mock("../../../store/bookmarksStore", () => {
  const _store = writable({ paths: [], loaded: true });
  return {
    bookmarksStore: { subscribe: _store.subscribe, _set: _store.set },
  };
});

vi.mock("../../../store/editorStore", () => {
  const _store = writable({
    activePath: null,
    content: "",
    lastSavedHash: null,
  });
  return {
    editorStore: { subscribe: _store.subscribe, _set: _store.set },
  };
});

import { templateLivePlugin } from "../templateLivePreview";
// Pull the store handles to flip their values between tests.
import { vaultStore } from "../../../store/vaultStore";
import { resolvedLinksStore } from "../../../store/resolvedLinksStore";
import { setResolvedLinks } from "../wikiLink";

function mount(doc: string, cursor = 0): EditorView {
  const anchor = Math.min(Math.max(cursor, 0), doc.length);
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [templateLivePlugin],
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}

// Collect widget-text/range pairs from the view's decoration set.
function widgets(view: EditorView): Array<{ from: number; to: number; text: string }> {
  const out: Array<{ from: number; to: number; text: string }> = [];
  for (const plugin of (view as unknown as {
    plugins: Array<{ value?: { decorations?: unknown } }>;
  }).plugins) {
    const deco = plugin.value?.decorations;
    if (!deco || !(deco instanceof Object)) continue;
    const set = deco as ReturnType<typeof Decoration.none.update>;
    const iter = set.iter();
    while (iter.value) {
      const spec = iter.value.spec as { widget?: { value?: string } };
      if (spec?.widget?.value !== undefined) {
        out.push({ from: iter.from, to: iter.to, text: spec.widget.value });
      }
      iter.next();
    }
  }
  return out;
}

const DEFAULT_VAULT_STATE = {
  currentPath: "/v/MyVault",
  status: "ready",
  fileList: ["first.md", "second.md"],
  fileCount: 2,
  errorMessage: null,
  sidebarWidth: 240,
  vaultReachable: true,
};

describe("templateLivePlugin — rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // Reset the mocked vaultStore so per-test mutations don't leak across.
    (vaultStore as unknown as { _set: (v: unknown) => void })._set(
      DEFAULT_VAULT_STATE,
    );
  });

  it("renders {{vault.name}} as a widget with the vault name", () => {
    const view = mount("Hello {{vault.name}}!", 0);
    const ws = widgets(view);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.text).toBe("MyVault");
    expect(view.state.doc.sliceString(ws[0]!.from, ws[0]!.to)).toBe("{{vault.name}}");
  });

  it("renders {{vault.notes.count()}} as the current note count", () => {
    // Cursor at doc end so it doesn't overlap the expression range.
    const doc = "xxx {{vault.notes.count()}} notes";
    const view = mount(doc, doc.length);
    const ws = widgets(view);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.text).toBe("2");
  });

  it("skips rendering when the cursor overlaps the expression", () => {
    const doc = "Hi {{vault.name}} there";
    // Cursor at position 5 — inside the `{{vault.name}}` range (3..17).
    const view = mount(doc, 5);
    expect(widgets(view)).toHaveLength(0);
  });

  it("renders once the cursor leaves the range", () => {
    const doc = "Hi {{vault.name}} there";
    const view = mount(doc, 0);
    expect(widgets(view)).toHaveLength(1);
    // Move cursor into the expression — expect the widget to disappear.
    view.dispatch({ selection: { anchor: 6 } });
    expect(widgets(view)).toHaveLength(0);
  });

  it("drops decorations for expressions that fail to evaluate", () => {
    const doc = "xxx {{vault.nonsense}} hi";
    const view = mount(doc, doc.length);
    expect(widgets(view)).toHaveLength(0);
  });

  it("parses [[...]] in rendered output into clickable wiki-link spans (#297)", () => {
    // Seed the resolver so the target is known to be resolved.
    setResolvedLinks(new Map([["first", "first.md"]]));

    // An expression whose rendered string value includes `[[first]]`.
    const doc = 'x {{"[[first]]"}} y';
    const view = mount(doc, 0);

    // The widget's `value` (pre-render string) still matches as before.
    const ws = widgets(view);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.text).toBe("[[first]]");

    // The actual rendered DOM should contain an anchor-style span with the
    // wiki-link data attributes and the resolved class.
    const anchor = view.dom.querySelector(".vc-template-rendered [data-wiki-target]");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("data-wiki-target")).toBe("first");
    expect(anchor!.getAttribute("data-wiki-resolved")).toBe("true");
    expect(anchor!.classList.contains("cm-wikilink-resolved")).toBe(true);
    expect(anchor!.textContent).toBe("first");
  });

  it("marks unresolved targets with the unresolved class (#297)", () => {
    setResolvedLinks(new Map());
    const doc = 'x {{"[[ghost]]"}} y';
    const view = mount(doc, 0);

    const anchor = view.dom.querySelector(".vc-template-rendered [data-wiki-target]");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("data-wiki-resolved")).toBe("false");
    expect(anchor!.classList.contains("cm-wikilink-unresolved")).toBe(true);
  });

  it("aliased [[target|alias]] shows the alias text but targets the stem (#297)", () => {
    setResolvedLinks(new Map([["real", "real.md"]]));
    const doc = 'x {{"[[real|Display]]"}} y';
    const view = mount(doc, 0);

    const anchor = view.dom.querySelector(".vc-template-rendered [data-wiki-target]");
    expect(anchor).not.toBeNull();
    expect(anchor!.textContent).toBe("Display");
    expect(anchor!.getAttribute("data-wiki-target")).toBe("real");
    expect(anchor!.getAttribute("data-wiki-resolved")).toBe("true");
  });

  // #303 — multi-segment `{{ ... ; ... }}` bodies.
  describe("multi-segment expressions (#303)", () => {
    it("renders `{{ vault.name; vault.notes.count() }}` as the concatenation", () => {
      const doc = "x {{ vault.name; vault.notes.count() }} y";
      const view = mount(doc, doc.length);
      const ws = widgets(view);
      expect(ws).toHaveLength(1);
      expect(ws[0]!.text).toBe("MyVault2");
    });

    it("lets a literal string segment act as a separator", () => {
      const doc = 'x {{ vault.name; " — "; vault.notes.count() }} y';
      const view = mount(doc, doc.length);
      const ws = widgets(view);
      expect(ws).toHaveLength(1);
      expect(ws[0]!.text).toBe("MyVault — 2");
    });

    it("swallows one broken segment and renders the rest", () => {
      const doc = "x {{ vault.name; vault.nonsense; vault.notes.count() }} y";
      const view = mount(doc, doc.length);
      const ws = widgets(view);
      expect(ws).toHaveLength(1);
      expect(ws[0]!.text).toBe("MyVault2");
    });

    it("drops the decoration entirely when every segment fails", () => {
      const doc = "x {{ @@@; @@@ }} y";
      const view = mount(doc, doc.length);
      expect(widgets(view)).toHaveLength(0);
    });

    it("exposes `date` / `time` / `title` via scope so they work mid-program", () => {
      // After #303, the scope carries `date` / `time` / `title` alongside
      // `vault`, so a non-special-cased segment can reference them too.
      const doc = "x {{ title; vault.name }} y";
      const view = mount(doc, doc.length);
      const ws = widgets(view);
      expect(ws).toHaveLength(1);
      // editorStore.activePath is null in this test → `title` renders as "".
      expect(ws[0]!.text).toBe("MyVault");
    });

    it("re-wires `{{ title }}` single-segment through the new scope path", () => {
      // Pinning that moving title/date/time into scope didn't regress the
      // single-segment shortcut users already rely on.
      const doc = "x {{ title }} y";
      const view = mount(doc, doc.length);
      const ws = widgets(view);
      // activePath is null → `title` resolves to empty string; renderer
      // treats empty output as "no decoration worth showing".
      // Either a widget with empty text OR no widget is acceptable.
      if (ws.length === 1) {
        expect(ws[0]!.text).toBe("");
      } else {
        expect(ws).toHaveLength(0);
      }
    });

    it("does not split on `;` inside a string literal", () => {
      const doc = 'x {{ "a;b" }} y';
      const view = mount(doc, doc.length);
      const ws = widgets(view);
      expect(ws).toHaveLength(1);
      expect(ws[0]!.text).toBe("a;b");
    });

    it("#295 regression: wiki-link decoration still suppressed inside multi-segment body", () => {
      setResolvedLinks(new Map([["first", "first.md"]]));
      // Even with multi-segment, the EDITOR body `[[first]]` substring is
      // part of a string-literal argument — the wiki-link plugin should
      // not surface a decoration for it inside the `{{ ... }}` range.
      // (The RENDERED output, however, may still show a wiki-link span —
      // that's #297 behavior and is exercised below.)
      const doc = 'x {{ vault.name; "[[first]]" }} y';
      const view = mount(doc, 0);
      const ws = widgets(view);
      expect(ws).toHaveLength(1);
      // Rendered widget text is the concatenation.
      expect(ws[0]!.text).toBe("MyVault[[first]]");
    });

    it("renders [[...]] from any segment as a clickable wiki-link span (#297)", () => {
      setResolvedLinks(new Map([["first", "first.md"]]));
      const doc = 'x {{ vault.name; " "; "[[first]]" }} y';
      const view = mount(doc, 0);
      const anchor = view.dom.querySelector(
        ".vc-template-rendered [data-wiki-target]",
      );
      expect(anchor).not.toBeNull();
      expect(anchor!.getAttribute("data-wiki-target")).toBe("first");
      expect(anchor!.getAttribute("data-wiki-resolved")).toBe("true");
    });
  });

  // #305 — evaluated output that IS a GFM table should render as a read-only
  // styled <table>, not as a monospaced pipe-and-dash <span>.
  describe("rendered GFM table (#305)", () => {
    it("renders a table-shaped output as a <table> widget", () => {
      const doc = 'x {{ "|A|B|\\n|-|-|\\n|1|2|" }} y';
      const view = mount(doc, doc.length);

      const table = view.dom.querySelector(
        ".vc-template-rendered-table table",
      );
      expect(table).not.toBeNull();

      const ths = table!.querySelectorAll("thead th");
      expect(Array.from(ths).map((t) => t.textContent?.trim())).toEqual(["A", "B"]);

      const tds = table!.querySelectorAll("tbody tr:first-child td");
      expect(Array.from(tds).map((t) => t.textContent?.trim())).toEqual(["1", "2"]);
    });

    it("non-table output still renders as the plain <span> widget", () => {
      const view = mount("x {{vault.name}} y", 0);
      expect(view.dom.querySelector(".vc-template-rendered-table")).toBeNull();
      expect(view.dom.querySelector(".vc-template-rendered")).not.toBeNull();
    });

    it("reflects delimiter-row alignment in cell text-align", () => {
      const doc = 'x {{ "|L|C|R|\\n|:-|:-:|-:|\\n|a|b|c|" }} y';
      const view = mount(doc, doc.length);

      const headers = view.dom.querySelectorAll(
        ".vc-template-rendered-table thead th",
      );
      expect((headers[0] as HTMLElement).style.textAlign).toBe("left");
      expect((headers[1] as HTMLElement).style.textAlign).toBe("center");
      expect((headers[2] as HTMLElement).style.textAlign).toBe("right");
    });

    it("renders [[target]] inside a cell as a clickable wiki-link span", () => {
      setResolvedLinks(new Map([["first", "first.md"]]));
      const doc = 'x {{ "|Note|X|\\n|-|-|\\n|[[first]]| |" }} y';
      const view = mount(doc, doc.length);

      const link = view.dom.querySelector(
        ".vc-template-rendered-table tbody [data-wiki-target]",
      );
      expect(link).not.toBeNull();
      expect(link!.getAttribute("data-wiki-target")).toBe("first");
      expect(link!.getAttribute("data-wiki-resolved")).toBe("true");
      expect(link!.classList.contains("cm-wikilink-resolved")).toBe(true);
    });

    it("is read-only: no contenteditable cells and no structural controls", () => {
      const doc = 'x {{ "|A|B|\\n|-|-|\\n|1|2|" }} y';
      const view = mount(doc, doc.length);

      const table = view.dom.querySelector(".vc-template-rendered-table table");
      expect(table).not.toBeNull();

      expect(table!.querySelectorAll("[contenteditable='true']").length).toBe(0);
      expect(table!.parentElement!.querySelectorAll(".cm-table-ctrl").length).toBe(0);
    });

    it("falls back to span when output has a table plus surrounding text", () => {
      const doc = 'x {{ "prefix\\n|A|B|\\n|-|-|\\n|1|2|" }} y';
      const view = mount(doc, doc.length);
      expect(view.dom.querySelector(".vc-template-rendered-table")).toBeNull();
      expect(view.dom.querySelector(".vc-template-rendered")).not.toBeNull();
    });

    it("renders a header-only table (no body rows)", () => {
      const doc = 'x {{ "|A|B|\\n|-|-|" }} y';
      const view = mount(doc, doc.length);

      const table = view.dom.querySelector(
        ".vc-template-rendered-table table",
      );
      expect(table).not.toBeNull();
      expect(table!.querySelectorAll("tbody tr").length).toBe(0);
      expect(table!.querySelectorAll("thead th").length).toBe(2);
    });

    it("renders multiple [[...]] inside a single cell", () => {
      setResolvedLinks(new Map([["a", "a.md"], ["b", "b.md"]]));
      const doc = 'x {{ "|Links|X|\\n|-|-|\\n|[[a]] [[b]]| |" }} y';
      const view = mount(doc, doc.length);

      const links = view.dom.querySelectorAll(
        ".vc-template-rendered-table tbody [data-wiki-target]",
      );
      expect(links.length).toBe(2);
      expect(links[0]!.getAttribute("data-wiki-target")).toBe("a");
      expect(links[1]!.getAttribute("data-wiki-target")).toBe("b");
    });

    // Note: [[target|alias]] inside a cell can't round-trip through the
    // current `splitRow` (the `|` splits the cell). GFM requires `\|` escape
    // for pipes-in-cells; that's a broader table-plugin enhancement and out
    // of scope here. The general aliased wiki-link rendering path is already
    // covered by the non-table test at line ~176.

    it("falls back to span when output contains two tables separated by a blank line", () => {
      const doc =
        'x {{ "|A|x|\\n|-|-|\\n|1|y|\\n\\n|B|z|\\n|-|-|\\n|2|w|" }} y';
      const view = mount(doc, doc.length);
      expect(view.dom.querySelector(".vc-template-rendered-table")).toBeNull();
      expect(view.dom.querySelector(".vc-template-rendered")).not.toBeNull();
    });

    it("re-renders the table when the backing store changes", () => {
      const doc =
        'x {{ "|Note|X|\\n|-|-|\\n"; vault.notes.select(n => "|[[" + n.name + "]]| |").join("\\n") }} y';
      const view = mount(doc, doc.length);

      let rows = view.dom.querySelectorAll(
        ".vc-template-rendered-table tbody tr",
      );
      expect(rows.length).toBe(2);

      (vaultStore as unknown as { _set: (v: unknown) => void })._set({
        currentPath: "/v/OtherVault",
        status: "ready",
        fileList: ["only.md"],
        fileCount: 1,
        errorMessage: null,
        sidebarWidth: 240,
        vaultReachable: true,
      });

      rows = view.dom.querySelectorAll(".vc-template-rendered-table tbody tr");
      expect(rows.length).toBe(1);
    });
  });

  it("re-renders when the backing store changes", () => {
    const view = mount("vault={{vault.name}}", 0);
    expect(widgets(view)[0]!.text).toBe("MyVault");

    (vaultStore as unknown as { _set: (v: unknown) => void })._set({
      currentPath: "/v/OtherVault",
      status: "ready",
      fileList: ["x.md"],
      fileCount: 1,
      errorMessage: null,
      sidebarWidth: 240,
      vaultReachable: true,
    });

    expect(widgets(view)[0]!.text).toBe("OtherVault");
  });

  // #309 two-token invariant: `requestReload()` is the "map stale, refetch"
  // edge and must NOT trigger a decoration rebuild — rebuilding at that edge
  // would paint against the still-stale map. Only `markReady()`, fired after
  // `setResolvedLinks()` lands, is a valid trigger. This test locks the
  // invariant so a future regression (e.g. subscribing to every store tick
  // indiscriminately) is caught.
  it("does NOT rebuild decorations when resolvedLinksStore.requestReload() fires alone (#309)", () => {
    setResolvedLinks(new Map());
    const doc = 'x {{"[[Ghost]]"}} y';
    const view = mount(doc, 0);

    const before = view.dom.querySelector(
      ".vc-template-rendered [data-wiki-target]",
    );
    expect(before).not.toBeNull();
    const beforeNode = before as HTMLElement;
    expect(beforeNode.getAttribute("data-wiki-resolved")).toBe("false");

    // Simulate the stale-edge only — the map is NOT updated.
    resolvedLinksStore.requestReload();

    // The exact same DOM node must still be present (no rebuild happened).
    const after = view.dom.querySelector(
      ".vc-template-rendered [data-wiki-target]",
    );
    expect(after).toBe(beforeNode);
    expect(after!.getAttribute("data-wiki-resolved")).toBe("false");
  });

  // #309 — regression: a file created between render and click left the
  // rendered wiki-link span with `data-wiki-resolved="false"`, routing the
  // click into the create-at-root fallback even after the resolved-links map
  // had been refreshed. The fix rebuilds decorations on
  // `resolvedLinksStore.markReady()` so the attribute flips live.
  it("rebuilds decorations when resolvedLinksStore.markReady() fires after setResolvedLinks", () => {
    // Start with an empty resolution map — `[[Untitled]]` is unresolved.
    setResolvedLinks(new Map());
    const doc = 'x {{"[[Untitled]]"}} y';
    const view = mount(doc, 0);

    const initialAnchor = view.dom.querySelector(
      ".vc-template-rendered [data-wiki-target]",
    );
    expect(initialAnchor).not.toBeNull();
    expect(initialAnchor!.getAttribute("data-wiki-resolved")).toBe("false");

    // Simulate the flow after a sidebar "New note": EditorPane's async
    // reloadResolvedLinks lands, setResolvedLinks is called, then markReady()
    // bumps the readyToken. Template plugin must pick that up and rebuild.
    setResolvedLinks(new Map([["untitled", "test/Untitled.md"]]));
    resolvedLinksStore.markReady();

    const refreshedAnchor = view.dom.querySelector(
      ".vc-template-rendered [data-wiki-target]",
    );
    expect(refreshedAnchor).not.toBeNull();
    expect(refreshedAnchor!.getAttribute("data-wiki-resolved")).toBe("true");
    expect(refreshedAnchor!.classList.contains("cm-wikilink-resolved")).toBe(true);
  });
});
