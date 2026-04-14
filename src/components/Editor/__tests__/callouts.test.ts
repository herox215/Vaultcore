import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { parseCallout } from "../callouts";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] })],
  });
}

// Helper: find the first Blockquote node's from/to in the syntax tree
function findBlockquote(state: EditorState): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    enter(node: { name: string; from: number; to: number }) {
      if (node.name === "Blockquote" && result === null) {
        result = { from: node.from, to: node.to };
      }
    },
  });
  return result;
}

describe("parseCallout", () => {
  it("extracts type, title, and empty collapsibleMod from a simple callout", () => {
    const doc = "> [!note] My Title\n> Body line.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("note");
    expect(info!.title).toBe("My Title");
    expect(info!.collapsibleMod).toBe("");
  });

  it("falls back to capitalized type name when no title is given", () => {
    const doc = "> [!warning]\n> Body.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).not.toBeNull();
    expect(info!.title).toBe("Warning");
  });

  it("extracts '+' collapsibleMod", () => {
    const doc = "> [!tip]+ Collapsible open\n> Body.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).not.toBeNull();
    expect(info!.collapsibleMod).toBe("+");
    expect(info!.title).toBe("Collapsible open");
  });

  it("extracts '-' collapsibleMod", () => {
    const doc = "> [!danger]- Collapsible closed\n> Body.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).not.toBeNull();
    expect(info!.collapsibleMod).toBe("-");
  });

  it("extracts multiline body", () => {
    const doc = "> [!info] Title\n> Line one.\n> Line two.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).not.toBeNull();
    expect(info!.body).toContain("Line one.");
    expect(info!.body).toContain("Line two.");
  });

  it("returns null for a plain blockquote that is not a callout", () => {
    const doc = "> This is just a blockquote.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).toBeNull();
  });

  it("normalizes unknown types to 'note'", () => {
    const doc = "> [!custom] Custom type\n> Body.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("note");
  });

  it("handles uppercase type names", () => {
    const doc = "> [!WARNING] Loud warning\n> Body.\n";
    const state = makeState(doc);
    const bq = findBlockquote(state);
    expect(bq).not.toBeNull();
    const info = parseCallout(state, bq!.from, bq!.to);
    expect(info).not.toBeNull();
    expect(info!.type).toBe("warning");
    expect(info!.title).toBe("Loud warning");
  });
});
