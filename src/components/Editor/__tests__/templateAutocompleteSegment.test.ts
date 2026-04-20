// Segment-scoped autocomplete inside `{{ ... }}` bodies (#303).
//
// When a body contains multiple `;`-separated segments, the completion
// source must only analyze the segment containing the cursor — otherwise
// a prior segment like `vault.notes.` would confuse the analyzer into
// thinking the user is still navigating that chain.
//
// These tests pin the behavior via the CompletionContext API directly,
// which is fast and independent of the async popup lifecycle.

import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
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

function makeCtx(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, pos, explicit);
}

function labels(result: ReturnType<typeof templateCompletionSource>): string[] {
  if (!result) return [];
  return result.options.map((o) => o.label);
}

describe("templateCompletionSource — segment scoping (#303)", () => {
  it("offers root-scope completions in a fresh second segment", () => {
    // `{{ vault.notes; |}}` — cursor at the `|` in second segment
    const doc = "{{ vault.notes; }}";
    const pos = "{{ vault.notes; ".length;
    const res = templateCompletionSource(makeCtx(doc, pos, true));
    expect(labels(res)).toContain("vault");
  });

  it("offers root-scope completions after typing a letter in the second segment", () => {
    const doc = "{{ vault.notes; v}}";
    const pos = "{{ vault.notes; v".length;
    const res = templateCompletionSource(makeCtx(doc, pos));
    expect(labels(res)).toContain("vault");
  });

  it("restricts completions to the segment even when a prior segment ends in `.`", () => {
    // Prior segment `vault.notes.` would, if the analyzer saw the whole
    // body, suggest Collection<Note> members. After scoping to the right
    // segment, we should see `vault` (root scope) instead.
    const doc = "{{ vault.notes.; v}}";
    const pos = "{{ vault.notes.; v".length;
    const res = templateCompletionSource(makeCtx(doc, pos));
    expect(labels(res)).toContain("vault");
    // Not a Collection<Note> member like `count`:
    expect(labels(res)).not.toContain("count");
  });

  it("a `;` inside a string literal in segment 1 does NOT split — segment 2 analysis still correct", () => {
    const doc = '{{ "a;b"; v}}';
    const pos = '{{ "a;b"; v'.length;
    const res = templateCompletionSource(makeCtx(doc, pos));
    expect(labels(res)).toContain("vault");
  });

  it("first segment is still completed correctly (no cross-contamination)", () => {
    // With a trailing `;` after the cursor, we're still in segment 1 —
    // must behave exactly like it would without the `;` at all.
    const doc = "{{ vault.; other}}";
    const pos = "{{ vault.".length;
    const res = templateCompletionSource(makeCtx(doc, pos));
    // Vault properties like `name` or `notes` should show up.
    expect(labels(res)).toContain("name");
  });
});
