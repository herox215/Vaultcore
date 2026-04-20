// CodeMirror 6 bridge between right-clicks in the editor and the VaultCore
// custom context menu (#301). The extension:
//
//   1. Listens for `contextmenu` events on `view.dom` and forwards them to
//      a Svelte-side callback with viewport-fixed coordinates. The native
//      browser menu is suppressed via `preventDefault`.
//
//   2. If the click position lies outside the current CM6 selection, moves
//      the caret to the clicked position before the menu opens. Without
//      this, right-clicking on a different word and picking `Cut` would
//      act on the stale selection — surprising.
//
// The extension stays a pure CM6 module so it can be unit-tested with a
// minimal EditorView and carries no dependency on Svelte stores.
//
// `insertTemplateExpression` is the commit helper the modal calls with the
// generated DSL string. It replaces the current selection with `{{ expr }}`
// and leaves the caret after the closing `}}` — tagged with
// `userEvent: "input.template"` so undo groups the insert correctly.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export type ContextMenuOpen = (
  view: EditorView,
  x: number,
  y: number,
) => void;

export function editorContextMenuExtension(onOpen: ContextMenuOpen): Extension {
  return EditorView.domEventHandlers({
    contextmenu: (event, view) => {
      event.preventDefault();
      event.stopPropagation();

      const clickPos = view.posAtCoords(
        { x: event.clientX, y: event.clientY },
        false,
      );
      if (clickPos !== null) {
        const sel = view.state.selection.main;
        const inside = clickPos >= sel.from && clickPos <= sel.to;
        if (!inside) {
          view.dispatch({ selection: { anchor: clickPos } });
        }
      }
      onOpen(view, event.clientX, event.clientY);
      return true;
    },
  });
}

export function insertTemplateExpression(view: EditorView, dsl: string): void {
  const sel = view.state.selection.main;
  const insert = `{{ ${dsl} }}`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    userEvent: "input.template",
  });
}
