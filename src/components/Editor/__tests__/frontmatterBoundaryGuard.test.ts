// Regression guards for issue #80: the frontmatterBoundaryGuard transaction
// filter used to drop the body-side portion of a deletion whenever a single
// user-input transaction spanned the frontmatter boundary (e.g. Cmd-A → type,
// or a paste that replaced a range starting inside the frontmatter and
// extending into the body). The body stayed intact while the inserted text
// landed at region.to, which the user perceived as "the whole document
// moved to the end".

import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { buildExtensions } from "../extensions";

function mountView(doc: string): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: buildExtensions(() => {}) }),
    parent,
  });
  return { view, parent };
}

describe("frontmatterBoundaryGuard — issue #80", () => {
  it("replaces the whole doc (Cmd-A + type) without leaking the original body", () => {
    const doc = "---\ntitle: Test\n---\n# Body\nHello\nWorld\n";
    const { view, parent } = mountView(doc);

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "X" },
      userEvent: "input.type",
    });

    expect(view.state.doc.toString()).toBe("---\ntitle: Test\n---\nX");

    view.destroy();
    parent.remove();
  });

  it("preserves the body-side portion of a deletion that spans the frontmatter boundary", () => {
    const doc = "---\ntitle: Test\n---\n# Body\nHello\n";
    const regionEnd = doc.indexOf("# Body");

    const { view, parent } = mountView(doc);
    view.dispatch({
      changes: { from: 0, to: regionEnd + 3, insert: "YYY" },
      userEvent: "input.type",
    });

    // "# B" (3 body chars) is deleted, "YYY" lands at regionEnd,
    // "ody\nHello\n" is preserved.
    expect(view.state.doc.toString()).toBe("---\ntitle: Test\n---\nYYYody\nHello\n");

    view.destroy();
    parent.remove();
  });

  it("redirects a simple insert at cursor 0 past the frontmatter block", () => {
    const doc = "---\ntitle: Test\n---\n# Body\n";
    const { view, parent } = mountView(doc);

    view.dispatch({
      changes: { from: 0, to: 0, insert: "X" },
      userEvent: "input.type",
    });

    expect(view.state.doc.toString()).toBe("---\ntitle: Test\n---\nX# Body\n");

    view.destroy();
    parent.remove();
  });

  it("handles insert at cursor 0 when body is empty", () => {
    const doc = "---\ntitle: Only frontmatter\n---\n";
    const { view, parent } = mountView(doc);

    view.dispatch({
      changes: { from: 0, to: 0, insert: "X" },
      userEvent: "input.type",
    });

    expect(view.state.doc.toString()).toBe("---\ntitle: Only frontmatter\n---\nX");

    view.destroy();
    parent.remove();
  });

  it("passes body-only edits through unchanged", () => {
    const doc = "---\ntitle: T\n---\nAlpha\nBeta\n";
    const alphaStart = doc.indexOf("Alpha");
    const { view, parent } = mountView(doc);

    view.dispatch({
      changes: { from: alphaStart, to: alphaStart + 5, insert: "Gamma" },
      userEvent: "input.type",
    });

    expect(view.state.doc.toString()).toBe("---\ntitle: T\n---\nGamma\nBeta\n");

    view.destroy();
    parent.remove();
  });

  it("does not intervene when there is no frontmatter", () => {
    const doc = "Plain note\nLine 2\n";
    const { view, parent } = mountView(doc);

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "Z" },
      userEvent: "input.type",
    });

    expect(view.state.doc.toString()).toBe("Z");

    view.destroy();
    parent.remove();
  });

  it("leaves non-input transactions (deleteLine, delete.backward) untouched", () => {
    const doc = "---\ntitle: T\n---\n# Body\n";
    const { view, parent } = mountView(doc);

    // Simulate deleteLine dispatching at cursor 0 — the CM command uses
    // userEvent "delete.line", which must NOT be rewritten by the guard.
    view.dispatch({
      changes: { from: 0, to: 4 },
      userEvent: "delete.line",
    });

    expect(view.state.doc.toString()).toBe("title: T\n---\n# Body\n");

    view.destroy();
    parent.remove();
  });
});
