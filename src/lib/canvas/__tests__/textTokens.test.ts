import { describe, it, expect } from "vitest";
import { tokenizeCanvasText } from "../textTokens";

describe("tokenizeCanvasText", () => {
  it("returns a single text segment for plain text", () => {
    expect(tokenizeCanvasText("hello world")).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(tokenizeCanvasText("")).toEqual([]);
  });

  it("tokenises a single [[target]] as a link", () => {
    expect(tokenizeCanvasText("see [[Welcome]] for more")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", target: "Welcome", display: "Welcome" },
      { kind: "text", text: " for more" },
    ]);
  });

  it("uses alias as display text when [[target|alias]] is given", () => {
    expect(tokenizeCanvasText("[[Welcome|start here]]")).toEqual([
      { kind: "link", target: "Welcome", display: "start here" },
    ]);
  });

  it("renders ![[image.png]] as an image segment", () => {
    expect(tokenizeCanvasText("before ![[photo.png]] after")).toEqual([
      { kind: "text", text: "before " },
      { kind: "image", target: "photo.png" },
      { kind: "text", text: " after" },
    ]);
  });

  it("recognises common image extensions case-insensitively", () => {
    const cases = ["a.PNG", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.bmp"];
    for (const target of cases) {
      const tokens = tokenizeCanvasText(`![[${target}]]`);
      expect(tokens).toEqual([{ kind: "image", target }]);
    }
  });

  it("treats ![[note.md]] and ![[canvas.canvas]] as regular links (embed fallback)", () => {
    expect(tokenizeCanvasText("![[MyNote]]")).toEqual([
      { kind: "link", target: "MyNote", display: "MyNote" },
    ]);
    expect(tokenizeCanvasText("![[Diagram.canvas]]")).toEqual([
      { kind: "link", target: "Diagram.canvas", display: "Diagram.canvas" },
    ]);
  });

  it("handles multiple tokens in one string", () => {
    expect(tokenizeCanvasText("[[A]] and ![[b.png]] then [[C|cee]]")).toEqual([
      { kind: "link", target: "A", display: "A" },
      { kind: "text", text: " and " },
      { kind: "image", target: "b.png" },
      { kind: "text", text: " then " },
      { kind: "link", target: "C", display: "cee" },
    ]);
  });

  it("keeps surrounding text intact when tokens touch start or end", () => {
    expect(tokenizeCanvasText("[[Start]]")).toEqual([
      { kind: "link", target: "Start", display: "Start" },
    ]);
    expect(tokenizeCanvasText("tail [[End]]")).toEqual([
      { kind: "text", text: "tail " },
      { kind: "link", target: "End", display: "End" },
    ]);
  });

  it("ignores a lone `[[` without closing brackets", () => {
    expect(tokenizeCanvasText("broken [[ example")).toEqual([
      { kind: "text", text: "broken [[ example" },
    ]);
  });

  it("uses non-greedy matching across consecutive tokens", () => {
    expect(tokenizeCanvasText("[[a]][[b]]")).toEqual([
      { kind: "link", target: "a", display: "a" },
      { kind: "link", target: "b", display: "b" },
    ]);
  });

  it("treats [[...]] inside {{ ... }} as plain text (#332)", () => {
    expect(tokenizeCanvasText("{{ [[Target]] }}")).toEqual([
      { kind: "text", text: "{{ [[Target]] }}" },
    ]);
  });

  it("treats complex template [[...]] as plain text", () => {
    expect(tokenizeCanvasText('{{ "[[" + f.name + "]]" }}')).toEqual([
      { kind: "text", text: '{{ "[[" + f.name + "]]" }}' },
    ]);
  });

  it("treats ![[image.png]] inside {{ ... }} as plain text", () => {
    expect(tokenizeCanvasText("{{ ![[photo.png]] }}")).toEqual([
      { kind: "text", text: "{{ ![[photo.png]] }}" },
    ]);
  });

  it("skips links inside templates but keeps real links outside", () => {
    expect(tokenizeCanvasText("[[A]] before {{ [[B]] }} then [[C|cee]]")).toEqual([
      { kind: "link", target: "A", display: "A" },
      { kind: "text", text: " before {{ [[B]] }} then " },
      { kind: "link", target: "C", display: "cee" },
    ]);
  });

  it("treats [[...]] inside template as plain text when adjacent to a real link", () => {
    expect(tokenizeCanvasText("[[A]]{{ [[B]] }}")).toEqual([
      { kind: "link", target: "A", display: "A" },
      { kind: "text", text: "{{ [[B]] }}" },
    ]);
  });

  it("skips wiki-links inside multiple separate templates", () => {
    expect(tokenizeCanvasText("{{ [[A]] }} x {{ [[B]] }} [[C]]")).toEqual([
      { kind: "text", text: "{{ [[A]] }} x {{ [[B]] }} " },
      { kind: "link", target: "C", display: "C" },
    ]);
  });

  it("handles template at start of string", () => {
    expect(tokenizeCanvasText("{{ [[A]] }} then [[B]]")).toEqual([
      { kind: "text", text: "{{ [[A]] }} then " },
      { kind: "link", target: "B", display: "B" },
    ]);
  });

  it("handles template at end of string", () => {
    expect(tokenizeCanvasText("[[A]] then {{ [[B]] }}")).toEqual([
      { kind: "link", target: "A", display: "A" },
      { kind: "text", text: " then {{ [[B]] }}" },
    ]);
  });

  it("skips wiki-link whose span overlaps a template expression", () => {
    expect(tokenizeCanvasText("[[foo{{bar}}baz]]")).toEqual([
      { kind: "text", text: "[[foo{{bar}}baz]]" },
    ]);
  });

  it("template with no wiki-links does not affect behaviour", () => {
    expect(tokenizeCanvasText("see [[A]] and {{ date }}")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", target: "A", display: "A" },
      { kind: "text", text: " and {{ date }}" },
    ]);
  });
});
