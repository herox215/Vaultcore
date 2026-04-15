// Unit tests for the #tag CompletionSource (#68).
//
// We exercise the source directly with a real EditorState + CompletionContext
// (no EditorView or Tauri runtime needed). The tagsStore is driven by calling
// its internal subscribe with a mocked `listTags` IPC.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { writable } from "svelte/store";

// Mock the tagsStore before importing the source under test.
vi.mock("../../../store/tagsStore", () => {
  const _store = writable({
    tags: [
      { tag: "project", count: 5 },
      { tag: "projects/active", count: 2 },
      { tag: "productivity", count: 1 },
      { tag: "todo", count: 9 },
    ],
    loading: false,
    error: null,
  });
  return {
    tagsStore: {
      subscribe: _store.subscribe,
      reload: vi.fn(),
      reset: vi.fn(),
      // Exposed for tests — not part of the real store surface.
      _set: _store.set,
    },
  };
});

// Import after the mock so the source picks up the mocked store.
import { tagCompletionSource } from "../tagAutocomplete";
import { tagsStore } from "../../../store/tagsStore";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] })],
  });
}

/**
 * Build a CompletionContext anchored at `pos` (end of doc by default).
 * `explicit=false` mimics typing; `true` mimics Ctrl-Space.
 */
function makeCtx(
  doc: string,
  pos: number = doc.length,
  explicit = false,
): CompletionContext {
  const state = makeState(doc);
  return new CompletionContext(state, pos, explicit);
}

beforeEach(() => {
  // Reset store to default fixture before each test.
  (tagsStore as unknown as { _set: (v: unknown) => void })._set({
    tags: [
      { tag: "project", count: 5 },
      { tag: "projects/active", count: 2 },
      { tag: "productivity", count: 1 },
      { tag: "todo", count: 9 },
    ],
    loading: false,
    error: null,
  });
});

describe("tagCompletionSource", () => {
  it("returns all tags when user types `#` at line start (explicit)", () => {
    const ctx = makeCtx("#", 1, true);
    const result = tagCompletionSource(ctx);
    expect(result).not.toBeNull();
    expect(result!.from).toBe(1);
    expect(result!.options.map((o) => o.label)).toEqual([
      "project",
      "projects/active",
      "productivity",
      "todo",
    ]);
  });

  it("does not fire on bare `#` during typing (non-explicit) — avoids markdown headings", () => {
    const ctx = makeCtx("#", 1, false);
    expect(tagCompletionSource(ctx)).toBeNull();
  });

  it("returns candidates when a prefix is typed — CM6 filters the visible list", () => {
    const ctx = makeCtx("#proj");
    const result = tagCompletionSource(ctx);
    expect(result).not.toBeNull();
    // `from` points after the `#`, so CM6's built-in prefix filter matches
    // `proj` against each label (project, projects/active, productivity…).
    expect(result!.from).toBe(1);
    // We hand back the full set; CM6 narrows it — verify our labels are there.
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("project");
    expect(labels).toContain("projects/active");
  });

  it("inserts the bare tag text via the `apply` string (Enter behaviour)", () => {
    const ctx = makeCtx("#proj");
    const result = tagCompletionSource(ctx)!;
    const opt = result.options.find((o) => o.label === "project")!;
    expect(opt.apply).toBe("project");
  });

  it("triggers after whitespace — `hello #t` is a valid tag-start", () => {
    const ctx = makeCtx("hello #t");
    const result = tagCompletionSource(ctx);
    expect(result).not.toBeNull();
    expect(result!.from).toBe("hello #".length);
  });

  it("does NOT trigger inside a URL fragment (`example.com/page#frag`)", () => {
    const ctx = makeCtx("see example.com/page#frag");
    expect(tagCompletionSource(ctx)).toBeNull();
  });

  it("does NOT trigger when `#` follows a word character (`abc#def`)", () => {
    const ctx = makeCtx("abc#def");
    expect(tagCompletionSource(ctx)).toBeNull();
  });

  it("does NOT trigger inside a fenced code block", () => {
    const doc = "```\n#proj\n```\n";
    // Cursor just after `#proj` inside the fence.
    const pos = doc.indexOf("#proj") + "#proj".length;
    const ctx = makeCtx(doc, pos);
    expect(tagCompletionSource(ctx)).toBeNull();
  });

  it("does NOT trigger inside inline code (`` `#proj` ``)", () => {
    const doc = "text `#proj` more";
    const pos = doc.indexOf("#proj") + "#proj".length;
    const ctx = makeCtx(doc, pos);
    expect(tagCompletionSource(ctx)).toBeNull();
  });

  it("returns null when the tags store is empty", () => {
    (tagsStore as unknown as { _set: (v: unknown) => void })._set({
      tags: [],
      loading: false,
      error: null,
    });
    const ctx = makeCtx("#t");
    expect(tagCompletionSource(ctx)).toBeNull();
  });

  it("reflects newly added tags reactively — next firing picks them up", () => {
    (tagsStore as unknown as { _set: (v: unknown) => void })._set({
      tags: [{ tag: "fresh", count: 1 }],
      loading: false,
      error: null,
    });
    const ctx = makeCtx("#f");
    const result = tagCompletionSource(ctx);
    expect(result).not.toBeNull();
    expect(result!.options.map((o) => o.label)).toEqual(["fresh"]);
  });

  it("supports nested tag segments (`#projects/a`)", () => {
    const ctx = makeCtx("#projects/a");
    const result = tagCompletionSource(ctx);
    expect(result).not.toBeNull();
    expect(result!.from).toBe(1);
    expect(result!.options.map((o) => o.label)).toContain("projects/active");
  });
});
