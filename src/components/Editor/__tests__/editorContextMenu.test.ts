// Unit tests for the CM6 extension that bridges right-clicks in the editor
// to the VaultCore custom context menu (#301). The extension:
//   1. Intercepts `contextmenu` events on `view.dom`, prevents the default
//      OS menu, and invokes the `onOpen` callback with the CM6 view and the
//      viewport-fixed coordinates.
//   2. When the click lands outside the current selection, moves the caret
//      to the clicked position first — so a subsequent Cut/Copy operates on
//      the word the user right-clicked on, not a stale selection.
//   3. Inserts a template expression at the current selection, replacing it,
//      leaving the caret after `}}`.

import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  editorContextMenuExtension,
  insertTemplateExpression,
} from "../editorContextMenu";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, onOpen: (view: EditorView, x: number, y: number) => void): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [editorContextMenuExtension(onOpen)],
  });
  view = new EditorView({ state, parent });
  return view;
}

function fireContextMenu(v: EditorView, x: number, y: number): MouseEvent {
  const ev = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  // CM6's domEventHandlers attach to the contentDOM (the editable child).
  // Dispatching on the outer `.cm-editor` wouldn't reach it because events
  // only bubble upward.
  v.contentDOM.dispatchEvent(ev);
  return ev;
}

describe("editorContextMenu extension", () => {
  it("fires onOpen with viewport coords and prevents the native menu", () => {
    const onOpen = vi.fn();
    const v = mount("hello world", onOpen);
    const ev = fireContextMenu(v, 42, 88);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [calledView, x, y] = onOpen.mock.calls[0]!;
    expect(calledView).toBe(v);
    expect(x).toBe(42);
    expect(y).toBe(88);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("leaves the existing selection intact when the click is inside it", () => {
    const onOpen = vi.fn();
    const v = mount("hello world", onOpen);
    // Select "hello" (0..5).
    v.dispatch({ selection: { anchor: 0, head: 5 } });
    // Mock posAtCoords to return a position inside the selection.
    const posSpy = vi.spyOn(v, "posAtCoords").mockImplementation(() => 2);
    fireContextMenu(v, 10, 10);
    expect(v.state.selection.main.from).toBe(0);
    expect(v.state.selection.main.to).toBe(5);
    posSpy.mockRestore();
  });

  it("moves the caret to the click position when the click is outside the selection", () => {
    const onOpen = vi.fn();
    const v = mount("hello world", onOpen);
    v.dispatch({ selection: { anchor: 0, head: 5 } }); // "hello"
    const posSpy = vi.spyOn(v, "posAtCoords").mockImplementation(() => 9); // inside "world"
    fireContextMenu(v, 100, 10);
    expect(v.state.selection.main.from).toBe(9);
    expect(v.state.selection.main.to).toBe(9);
    posSpy.mockRestore();
  });

  it("leaves an empty-collapsed selection alone when posAtCoords returns null", () => {
    const onOpen = vi.fn();
    const v = mount("hello world", onOpen);
    v.dispatch({ selection: { anchor: 3, head: 3 } });
    const posSpy = vi.spyOn(v, "posAtCoords").mockImplementation(() => null);
    fireContextMenu(v, -50, -50);
    expect(v.state.selection.main.head).toBe(3);
    posSpy.mockRestore();
  });
});

describe("insertTemplateExpression helper", () => {
  it("inserts `{{ expr }}` at a collapsed caret and leaves the caret after `}}`", () => {
    const v = mount("prefix suffix", vi.fn());
    v.dispatch({ selection: { anchor: 7, head: 7 } }); // between "prefix " and "suffix"
    insertTemplateExpression(v, "vault.name");
    expect(v.state.doc.toString()).toBe("prefix {{ vault.name }}suffix");
    expect(v.state.selection.main.head).toBe("prefix {{ vault.name }}".length);
  });

  it("replaces an existing selection with the template expression", () => {
    const v = mount("hello world", vi.fn());
    v.dispatch({ selection: { anchor: 0, head: 5 } }); // select "hello"
    insertTemplateExpression(v, "vault.name");
    expect(v.state.doc.toString()).toBe("{{ vault.name }} world");
    expect(v.state.selection.main.head).toBe("{{ vault.name }}".length);
  });

  it("tags the insert with userEvent `input.template` so undo groups correctly", () => {
    const seen: string[] = [];
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          EditorView.updateListener.of((update) => {
            for (const tr of update.transactions) {
              if (tr.isUserEvent("input.template")) seen.push("input.template");
            }
          }),
        ],
      }),
      parent,
    });
    insertTemplateExpression(view, "vault.name");
    expect(seen).toEqual(["input.template"]);
  });
});
