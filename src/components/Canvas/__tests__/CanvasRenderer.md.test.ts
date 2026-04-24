// #364 — canvas text nodes render Markdown HTML passed via the
// `mdTextNodes` prop, identical to how file-node previews use
// `mdPreviews`. These tests cover:
//   - pass-through rendering of pre-rendered HTML,
//   - wiki-link click delegation in interactive mode,
//   - no click dispatch in read-only (embed) mode,
//   - outer-card `onkeydown` must not fire when the node is being
//     edited (otherwise Enter/Space in the textarea re-triggers
//     startEditText and swallows the newline).

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import CanvasRenderer from "../CanvasRenderer.svelte";
import type { CanvasDoc } from "../../../lib/canvas/types";

function docOf(nodes: CanvasDoc["nodes"], edges: CanvasDoc["edges"] = []): CanvasDoc {
  return { nodes, edges, extra: {} };
}

describe("CanvasRenderer markdown text nodes (#364)", () => {
  it("renders pre-rendered markdown HTML via mdTextNodes", () => {
    const doc = docOf([
      { id: "t", type: "text", text: "**bold**", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: {
        doc,
        interactive: true,
        mdTextNodes: { t: "<p><strong>bold</strong></p>" },
      },
    });
    const content = container.querySelector(".vc-canvas-node-md-text");
    expect(content).toBeTruthy();
    expect(content!.innerHTML).toContain("<strong>bold</strong>");
  });

  it("falls back to raw text when mdTextNodes does not yet contain the node id", () => {
    // Defensive: a newly-added node may render for one frame before the
    // caller's $derived populates its HTML. Silent-blank would be scary;
    // raw text is fine for a single frame.
    const doc = docOf([
      { id: "new", type: "text", text: "brand new", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: { doc, interactive: true, mdTextNodes: {} },
    });
    const content = container.querySelector(".vc-canvas-node-md-text")!;
    expect(content.textContent).toContain("brand new");
  });

  it("renders the empty-card fallback when text is empty", () => {
    const doc = docOf([
      { id: "t", type: "text", text: "", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: { doc, interactive: true, mdTextNodes: { t: "" } },
    });
    const content = container.querySelector(".vc-canvas-node-md-text")!;
    expect(content.textContent?.trim()).toBe("Empty card");
  });

  it("clicking a wiki-link target dispatches onOpenWikiTarget (interactive=true)", async () => {
    const onOpenWikiTarget = vi.fn();
    const doc = docOf([
      { id: "t", type: "text", text: "see [[Welcome]]", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: {
        doc,
        interactive: true,
        onOpenWikiTarget,
        mdTextNodes: {
          t: '<p>see <a class="vc-wiki-link" data-wiki-target="Welcome">Welcome</a></p>',
        },
      },
    });
    const link = container.querySelector<HTMLElement>("[data-wiki-target]")!;
    await fireEvent.click(link);
    expect(onOpenWikiTarget).toHaveBeenCalledTimes(1);
    expect(onOpenWikiTarget).toHaveBeenCalledWith("Welcome");
  });

  it("wiki-link clicks do not dispatch when interactive=false (read-only embed)", async () => {
    const onOpenWikiTarget = vi.fn();
    const doc = docOf([
      { id: "t", type: "text", text: "see [[Welcome]]", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: {
        doc,
        interactive: false,
        onOpenWikiTarget,
        mdTextNodes: {
          t: '<p>see <a class="vc-wiki-link" data-wiki-target="Welcome">Welcome</a></p>',
        },
      },
    });
    const link = container.querySelector<HTMLElement>("[data-wiki-target]")!;
    await fireEvent.click(link);
    expect(onOpenWikiTarget).not.toHaveBeenCalled();
  });

  it("outer card does not swallow Enter/Space keys while the node is being edited", async () => {
    // Regression guard: the outer `<div role='button' onkeydown={onCardKey}>`
    // used to re-enter edit mode on any Enter/Space keypress bubbled up from
    // the inner textarea, preventing the user from typing a newline. The
    // renderer must attach onkeydown only when the node is NOT being edited.
    const onCardKey = vi.fn();
    const doc = docOf([
      { id: "t", type: "text", text: "hello", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: {
        doc,
        interactive: true,
        editingNodeId: "t",
        onCardKey,
        mdTextNodes: {},
      },
    });
    const card = container.querySelector<HTMLElement>('[data-node-id="t"]')!;
    await fireEvent.keyDown(card, { key: "Enter" });
    await fireEvent.keyDown(card, { key: " " });
    expect(onCardKey).not.toHaveBeenCalled();
  });

  it("outer card still handles Enter/Space to enter edit mode when NOT editing", async () => {
    const onCardKey = vi.fn();
    const doc = docOf([
      { id: "t", type: "text", text: "hello", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: {
        doc,
        interactive: true,
        editingNodeId: null,
        onCardKey,
        mdTextNodes: { t: "<p>hello</p>" },
      },
    });
    const card = container.querySelector<HTMLElement>('[data-node-id="t"]')!;
    await fireEvent.keyDown(card, { key: "Enter" });
    expect(onCardKey).toHaveBeenCalledTimes(1);
  });

  it("wiki-link clicks inside the textarea (during edit) do not trigger onOpenWikiTarget", async () => {
    // While editing, only the textarea is rendered — there is no HTML link
    // to click. The display branch is fully replaced. This asserts the
    // renderer does not render HTML and textarea simultaneously.
    const onOpenWikiTarget = vi.fn();
    const doc = docOf([
      { id: "t", type: "text", text: "[[Welcome]]", x: 0, y: 0, width: 200, height: 80 },
    ]);
    const { container } = render(CanvasRenderer, {
      props: {
        doc,
        interactive: true,
        editingNodeId: "t",
        onOpenWikiTarget,
        mdTextNodes: { t: '<p><a data-wiki-target="Welcome">Welcome</a></p>' },
      },
    });
    expect(container.querySelector("textarea")).toBeTruthy();
    expect(container.querySelector(".vc-canvas-node-md-text")).toBeNull();
  });
});
