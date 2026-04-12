/**
 * EDIT-07: Per-tab undo/redo isolation regression test.
 *
 * CM6 `history()` in buildExtensions assigns each EditorView its own history
 * stack. This is a regression guard — if someone refactors extensions.ts to
 * share a global history, this test fails.
 */
import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { buildExtensions } from "../extensions";

function makeView(initialDoc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc: initialDoc, extensions: buildExtensions(() => {}) }),
  });
}

describe("CM6 undo/redo is per-EditorView (EDIT-07)", () => {
  it("undo on view A leaves view B unchanged", () => {
    const a = makeView("A-initial");
    const b = makeView("B-initial");
    a.dispatch({ changes: { from: 0, to: a.state.doc.length, insert: "A-edited" } });
    b.dispatch({ changes: { from: 0, to: b.state.doc.length, insert: "B-edited" } });
    expect(a.state.doc.toString()).toBe("A-edited");
    expect(b.state.doc.toString()).toBe("B-edited");
    undo(a);
    expect(a.state.doc.toString()).toBe("A-initial");
    expect(b.state.doc.toString()).toBe("B-edited");
    a.destroy(); b.destroy();
  });

  it("redo on view A does not touch view B", () => {
    const a = makeView("A-initial");
    const b = makeView("B-initial");
    a.dispatch({ changes: { from: 0, to: a.state.doc.length, insert: "A-edited" } });
    b.dispatch({ changes: { from: 0, to: b.state.doc.length, insert: "B-edited" } });
    undo(a);
    redo(a);
    expect(a.state.doc.toString()).toBe("A-edited");
    expect(b.state.doc.toString()).toBe("B-edited");
    a.destroy(); b.destroy();
  });

  it("destroying view A does not disturb view B's history", () => {
    const a = makeView("A-initial");
    const b = makeView("B-initial");
    a.dispatch({ changes: { from: 0, to: a.state.doc.length, insert: "A-edited" } });
    b.dispatch({ changes: { from: 0, to: b.state.doc.length, insert: "B-edited" } });
    a.destroy();
    undo(b);
    expect(b.state.doc.toString()).toBe("B-initial");
    b.destroy();
  });
});
