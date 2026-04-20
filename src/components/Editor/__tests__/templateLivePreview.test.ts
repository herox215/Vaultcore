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

describe("templateLivePlugin — rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
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
});
