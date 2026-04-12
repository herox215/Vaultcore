import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { wrapSelection, wrapLink } from "../src/components/Editor/keymap";

function makeState(doc: string, selFrom: number, selTo: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(selFrom, selTo),
  });
}

function runCommand(
  state: EditorState,
  cmd: ReturnType<typeof wrapSelection> | typeof wrapLink
): { doc: string; selFrom: number; selTo: number } {
  let captured: EditorState = state;
  cmd({
    state,
    dispatch: (tr) => {
      captured = tr.state;
    },
  });
  const sel = captured.selection.main;
  return { doc: captured.doc.toString(), selFrom: sel.from, selTo: sel.to };
}

describe("EDIT-04: wrapSelection keymap commands", () => {
  it("EDIT-04: Mod-b wraps selection with ** on both sides", () => {
    const state = makeState("foo bar baz", 4, 7); // "bar"
    const out = runCommand(state, wrapSelection("**", "**"));
    expect(out.doc).toBe("foo **bar** baz");
    // selection now wraps just "bar" (without the asterisks)
    expect(out.doc.slice(out.selFrom, out.selTo)).toBe("bar");
  });

  it("EDIT-04: Mod-b on already-wrapped selection removes the ** wrapping (toggle)", () => {
    const state = makeState("foo **bar** baz", 6, 9); // "bar" inside **bar**
    const out = runCommand(state, wrapSelection("**", "**"));
    expect(out.doc).toBe("foo bar baz");
    expect(out.doc.slice(out.selFrom, out.selTo)).toBe("bar");
  });

  it("EDIT-04: Mod-i wraps selection with * on both sides", () => {
    const state = makeState("hello world", 6, 11); // "world"
    const out = runCommand(state, wrapSelection("*", "*"));
    expect(out.doc).toBe("hello *world*");
    expect(out.doc.slice(out.selFrom, out.selTo)).toBe("world");
  });

  it("EDIT-04: Mod-i on already-wrapped selection toggles off", () => {
    const state = makeState("hello *world*", 7, 12); // "world" inside *world*
    const out = runCommand(state, wrapSelection("*", "*"));
    expect(out.doc).toBe("hello world");
  });

  it("EDIT-04: Mod-k on non-empty selection replaces with [text](url) and positions cursor inside (url)", () => {
    const state = makeState("click here", 6, 10); // "here"
    const out = runCommand(state, wrapLink);
    expect(out.doc).toBe("click [here](url)");
    // cursor lands inside `(url)` -- selection covers the `url` placeholder
    expect(out.doc.slice(out.selFrom, out.selTo)).toBe("url");
  });

  it("EDIT-04: Mod-k on empty selection inserts [link text](url)", () => {
    const state = makeState("prefix ", 7, 7); // empty cursor
    const out = runCommand(state, wrapLink);
    expect(out.doc).toBe("prefix [link text](url)");
  });
});
