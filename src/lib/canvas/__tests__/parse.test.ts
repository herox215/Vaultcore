// Parser / serializer tests for the Obsidian `.canvas` format (#71, phase 1).
// The critical invariant is roundtrip preservation — opening, mutating one
// node, and saving must not drop unknown fields a producer wrote.

import { describe, it, expect } from "vitest";
import { parseCanvas, serializeCanvas, emptyCanvas } from "../parse";

describe("parseCanvas", () => {
  it("returns an empty doc for empty / whitespace input", () => {
    expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas("   \n  ")).toEqual({ nodes: [], edges: [] });
  });

  it("parses text nodes with coordinates and text", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "text",
            x: 10,
            y: 20,
            width: 200,
            height: 80,
            text: "hello",
          },
        ],
        edges: [],
      }),
    );
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]).toMatchObject({
      id: "a",
      type: "text",
      x: 10,
      y: 20,
      width: 200,
      height: 80,
      text: "hello",
    });
  });

  it("parses file / link / group node variants", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "f", type: "file", x: 0, y: 0, width: 1, height: 1, file: "note.md" },
          { id: "l", type: "link", x: 0, y: 0, width: 1, height: 1, url: "https://example.com" },
          { id: "g", type: "group", x: 0, y: 0, width: 10, height: 10, label: "Group A" },
        ],
        edges: [],
      }),
    );
    expect(doc.nodes[0]).toMatchObject({ type: "file", file: "note.md" });
    expect(doc.nodes[1]).toMatchObject({ type: "link", url: "https://example.com" });
    expect(doc.nodes[2]).toMatchObject({ type: "group", label: "Group A" });
  });

  it("parses edges with optional sides and colors", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [],
        edges: [
          {
            id: "e1",
            fromNode: "a",
            toNode: "b",
            fromSide: "right",
            toSide: "left",
            color: "#ff0000",
            label: "flow",
          },
        ],
      }),
    );
    expect(doc.edges[0]).toMatchObject({
      id: "e1",
      fromNode: "a",
      toNode: "b",
      fromSide: "right",
      toSide: "left",
      color: "#ff0000",
      label: "flow",
    });
  });

  it("drops nodes missing id or type", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          { type: "text", x: 0, y: 0, width: 1, height: 1, text: "no id" },
          { id: "x", x: 0, y: 0, width: 1, height: 1, text: "no type" },
          { id: "ok", type: "text", x: 0, y: 0, width: 1, height: 1, text: "keep" },
        ],
        edges: [],
      }),
    );
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]).toMatchObject({ id: "ok" });
  });

  it("fills missing coordinate / size fields with defaults", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "a", type: "text", text: "x" }],
        edges: [],
      }),
    );
    expect(doc.nodes[0]).toMatchObject({ x: 0, y: 0, width: 250, height: 60 });
  });

  it("captures unknown node fields in `extra`", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "text",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            text: "x",
            styleAttributes: { theme: "dark" },
            futureField: 42,
          },
        ],
        edges: [],
      }),
    );
    expect(doc.nodes[0]!.extra).toEqual({
      styleAttributes: { theme: "dark" },
      futureField: 42,
    });
  });

  it("captures unknown edge fields in `extra`", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [],
        edges: [
          {
            id: "e",
            fromNode: "a",
            toNode: "b",
            somethingNew: true,
          },
        ],
      }),
    );
    expect(doc.edges[0]!.extra).toEqual({ somethingNew: true });
  });

  it("captures unknown top-level fields in `extra`", () => {
    const doc = parseCanvas(
      JSON.stringify({
        nodes: [],
        edges: [],
        metadata: { v: 2 },
      }),
    );
    expect(doc.extra).toEqual({ metadata: { v: 2 } });
  });
});

describe("serializeCanvas", () => {
  it("writes tab-indented JSON with nodes+edges", () => {
    const out = serializeCanvas({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 250, height: 60, text: "hi" },
      ],
      edges: [],
    });
    expect(out).toContain("\t");
    const parsed = JSON.parse(out);
    expect(parsed.nodes[0]).toMatchObject({ id: "a", type: "text", text: "hi" });
    expect(parsed.edges).toEqual([]);
  });

  it("emits an empty canvas as nodes+edges arrays", () => {
    const out = serializeCanvas(emptyCanvas());
    expect(JSON.parse(out)).toEqual({ nodes: [], edges: [] });
  });

  it("roundtrips unknown node / edge / top-level fields", () => {
    const input = {
      nodes: [
        {
          id: "a",
          type: "text",
          x: 10,
          y: 20,
          width: 200,
          height: 80,
          text: "hi",
          styleAttributes: { theme: "dark" },
        },
        {
          id: "b",
          type: "futureType",
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          customProp: "keep me",
        },
      ],
      edges: [
        {
          id: "e",
          fromNode: "a",
          toNode: "b",
          somethingNew: [1, 2, 3],
        },
      ],
      metadata: { version: 2 },
    };
    const doc = parseCanvas(JSON.stringify(input));
    const out = serializeCanvas(doc);
    const parsed = JSON.parse(out);
    expect(parsed.nodes[0].styleAttributes).toEqual({ theme: "dark" });
    expect(parsed.nodes[1].type).toBe("futureType");
    expect(parsed.nodes[1].customProp).toBe("keep me");
    expect(parsed.edges[0].somethingNew).toEqual([1, 2, 3]);
    expect(parsed.metadata).toEqual({ version: 2 });
  });

  it("does not emit undefined optional fields", () => {
    const out = serializeCanvas({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "x" },
      ],
      edges: [{ id: "e", fromNode: "a", toNode: "a" }],
    });
    const parsed = JSON.parse(out);
    expect(parsed.nodes[0]).not.toHaveProperty("color");
    expect(parsed.edges[0]).not.toHaveProperty("fromSide");
    expect(parsed.edges[0]).not.toHaveProperty("toEnd");
  });
});
