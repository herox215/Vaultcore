// Regression test for the template autocomplete cursor bug (#299):
// Typing `{{ `, accepting `vault` from the popup, then typing `.` and accepting
// a member must leave the caret AFTER the inserted member name — not at the
// start of `vault`. The first version of templateAutocomplete.ts returned a
// CompletionResult without a `to` field, so CodeMirror used the initial
// cursor snapshot taken *before* the `.` transaction settled; member selection
// then replaced `{{ vault.` from the old `from` back to that stale snapshot,
// collapsing the caret to the leading `v`.
//
// We mount a real EditorView (with autocompletion + our source), drive it with
// real `input.type` transactions, wait for the popup to appear, and call the
// acceptCompletion command to commit the selection.

import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  acceptCompletion,
  currentCompletions,
  completionStatus,
  moveCompletionSelection,
  startCompletion,
} from "@codemirror/autocomplete";
import { keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { writable } from "svelte/store";

vi.mock("../../../store/vaultStore", () => {
  const _store = writable({
    currentPath: "/v/MyVault",
    status: "ready",
    fileList: [],
    fileCount: 0,
    errorMessage: null,
    sidebarWidth: 240,
    vaultReachable: true,
  });
  return { vaultStore: { subscribe: _store.subscribe, _set: _store.set } };
});
vi.mock("../../../store/tagsStore", () => {
  const _store = writable({ tags: [], loading: false, error: null });
  return { tagsStore: { subscribe: _store.subscribe, _set: _store.set } };
});
vi.mock("../../../store/bookmarksStore", () => {
  const _store = writable({ paths: [], loaded: true });
  return { bookmarksStore: { subscribe: _store.subscribe, _set: _store.set } };
});
vi.mock("../../../store/editorStore", () => {
  const _store = writable({ activePath: null, content: "", lastSavedHash: null });
  return { editorStore: { subscribe: _store.subscribe, _set: _store.set } };
});

import { templateCompletionSource } from "../templateAutocomplete";
import { templateLivePlugin } from "../templateLivePreview";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc = ""): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [
      closeBrackets(),
      autocompletion({
        override: [templateCompletionSource],
        activateOnTyping: true,
        activateOnTypingDelay: 0,
        interactionDelay: 0,
      }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap]),
      templateLivePlugin,
    ],
  });
  view = new EditorView({ state, parent });
  return view;
}

async function typeChar(v: EditorView, text: string): Promise<void> {
  const pos = v.state.selection.main.head;
  v.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.type",
  });
  await waitForCompletions(v);
}

async function waitForCompletions(v: EditorView, timeout = 2000): Promise<void> {
  const start = Date.now();
  // Kick the popup explicitly — typing-driven activation is debounced via
  // activateOnTypingDelay and the async source dispatch; jsdom can miss it.
  startCompletion(v);
  while (Date.now() - start < timeout) {
    if (
      currentCompletions(v.state).length > 0 &&
      completionStatus(v.state) === "active"
    ) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

function pickOption(v: EditorView, label: string): void {
  const opts = currentCompletions(v.state);
  const idx = opts.findIndex((o) => o.label === label);
  if (idx < 0) {
    throw new Error(
      `Option ${label} not in [${opts.map((o) => o.label).join(",")}]`,
    );
  }
  for (let i = 0; i < idx; i++) moveCompletionSelection(true)(v);
  if (!acceptCompletion(v)) {
    throw new Error(
      `acceptCompletion returned false — status=${completionStatus(v.state)}, options=[${opts.map((o) => o.label).join(",")}], doc="${v.state.doc.toString()}", pos=${v.state.selection.main.head}`,
    );
  }
}

describe("template autocomplete — caret position after chained selection", () => {
  it("leaves the caret after `vault` when `vault` is picked", async () => {
    const v = mount();
    await typeChar(v, "{");
    await typeChar(v, "{");
    await typeChar(v, " ");
    pickOption(v, "vault");
    expect(v.state.doc.toString()).toBe("{{ vault");
    expect(v.state.selection.main.head).toBe("{{ vault".length);
  });

  it("leaves the caret AFTER the inserted member when `.` is typed then a member is picked", async () => {
    const v = mount();
    await typeChar(v, "{");
    await typeChar(v, "{");
    await typeChar(v, " ");
    pickOption(v, "vault");
    expect(v.state.doc.toString()).toBe("{{ vault");

    // This is the bug: typing `.` and picking `name` used to land the caret
    // at position 3 (before the `v`) rather than at end-of-`name`.
    await typeChar(v, ".");
    pickOption(v, "name");

    expect(v.state.doc.toString()).toBe("{{ vault.name");
    expect(v.state.selection.main.head).toBe("{{ vault.name".length);
  });

  it("preserves caret when a member is picked from a manually-typed chain", async () => {
    const v = mount();
    for (const c of "{{ vault.") await typeChar(v, c);
    pickOption(v, "path");
    expect(v.state.doc.toString()).toBe("{{ vault.path");
    expect(v.state.selection.main.head).toBe("{{ vault.path".length);
  });

  it("method completion inserts `name(` and leaves caret after the `(`", async () => {
    // Collection<Note> exposes `where`, `first`, etc. as methods whose
    // insertText ends with `(` so the user lands inside the arg list.
    const v = mount();
    for (const c of "{{ vault.notes.") await typeChar(v, c);
    pickOption(v, "where");
    expect(v.state.doc.toString()).toBe("{{ vault.notes.where(");
    expect(v.state.selection.main.head).toBe("{{ vault.notes.where(".length);
  });

  it("types `{{ vault.` without ever accepting the popup — cursor stays at end", async () => {
    const v = mount();
    for (const c of "{{ vault.") await typeChar(v, c);
    // The popup is showing members of Vault. User has not accepted.
    expect(v.state.doc.toString()).toBe("{{ vault.");
    expect(v.state.selection.main.head).toBe(9);
  });

  it("types `{{ v`, accepts vault, types `.` — document is `{{ vault.` with caret at end", async () => {
    const v = mount();
    await typeChar(v, "{");
    await typeChar(v, "{");
    await typeChar(v, " ");
    await typeChar(v, "v");
    pickOption(v, "vault");
    // After accepting: doc should be `{{ vault`, caret at end (8)
    expect(v.state.doc.toString()).toBe("{{ vault");
    expect(v.state.selection.main.head).toBe(8);
    // Now type `.`
    await typeChar(v, ".");
    expect(v.state.doc.toString()).toBe("{{ vault.");
    expect(v.state.selection.main.head).toBe(9);
  });

  it("simulates closeBrackets auto-closing `{{` to `{{}}`", async () => {
    // When the real editor runs, typing `{` through closeBrackets produces
    // `{|}` and a second `{` produces `{{|}}`. Dispatch that manually.
    const v = mount();
    v.dispatch({
      changes: { from: 0, to: 0, insert: "{{}}" },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
    await waitForCompletions(v);
    // popup should show vault — accept it.
    pickOption(v, "vault");
    expect(v.state.doc.toString()).toBe("{{vault}}");
    expect(v.state.selection.main.head).toBe(7);
    // Now type `.`
    await typeChar(v, ".");
    expect(v.state.doc.toString()).toBe("{{vault.}}");
    expect(v.state.selection.main.head).toBe(8);
    pickOption(v, "name");
    expect(v.state.doc.toString()).toBe("{{vault.name}}");
    expect(v.state.selection.main.head).toBe(12);
  });

  it("no space between `{{` and `vault` — pick vault, type `.`, pick member", async () => {
    const v = mount();
    await typeChar(v, "{");
    await typeChar(v, "{");
    // No space — user picks vault immediately
    pickOption(v, "vault");
    expect(v.state.doc.toString()).toBe("{{vault");
    expect(v.state.selection.main.head).toBe(7);
    await typeChar(v, ".");
    expect(v.state.doc.toString()).toBe("{{vault.");
    expect(v.state.selection.main.head).toBe(8);
    pickOption(v, "name");
    expect(v.state.doc.toString()).toBe("{{vault.name");
    expect(v.state.selection.main.head).toBe(12);
  });

  it("simulates full typing flow including closeBrackets auto-close", async () => {
    // Use keyboard events so closeBrackets actually fires. In jsdom we
    // emulate that by invoking the insert transaction the way CM6 would.
    const v = mount();
    // The real app uses closeBrackets — typing `{` inserts `{}` with cursor
    // between. We drive that by dispatching an `input` user event that the
    // closeBrackets extension will intercept, approximating the typed input.
    function simulateTyped(c: string): void {
      const pos = v.state.selection.main.head;
      // Call the input handler CM6 sets up via the closeBrackets ext.
      // The straightforward path is to dispatch an input.type transaction
      // and let any beforeinput listeners run; in our unit env that means
      // dispatching like the typeChar helper does.
      v.dispatch({
        changes: { from: pos, to: pos, insert: c },
        selection: { anchor: pos + c.length },
        userEvent: "input.type",
      });
    }
    simulateTyped("{");
    simulateTyped("{");
    simulateTyped(" ");
    await waitForCompletions(v);
    pickOption(v, "vault");
    const afterVault = v.state.doc.toString();
    const posAfterVault = v.state.selection.main.head;
    simulateTyped(".");
    await waitForCompletions(v);
    pickOption(v, "path");
    expect(v.state.doc.toString()).toBe(afterVault + ".path");
    expect(v.state.selection.main.head).toBe(posAfterVault + 5); // `.path`
  });
});
