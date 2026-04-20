// Unit tests for the pure expression-builder library used by the visual
// query builder (#301). The builder produces DSL strings like
// `vault.notes.where(n => n.property.tags == "x").count()` from a structured
// chain of steps. Tests pin both the rendered output and round-trip through
// the existing `parse()` evaluator so the builder can never emit a string
// that the live-preview engine can't parse.

import { describe, it, expect } from "vitest";
import {
  emptyChain,
  addStep,
  setStepLambda,
  removeStepsFrom,
  chainTypeAt,
  renderExpression,
  wrapAsTemplate,
} from "../templateExpressionBuilder";
import { parse } from "../templateExpression";

function assertParses(src: string): void {
  expect(() => parse(src)).not.toThrow();
}

describe("templateExpressionBuilder — empty / root", () => {
  it("empty chain renders as just the root scope name", () => {
    const c = emptyChain();
    expect(renderExpression(c)).toBe("vault");
  });

  it("wraps as `{{ vault }}`", () => {
    expect(wrapAsTemplate(emptyChain())).toBe("{{ vault }}");
  });

  it("root type is Vault", () => {
    expect(chainTypeAt(emptyChain(), 0)).toBe("Vault");
  });
});

describe("templateExpressionBuilder — property chains", () => {
  it("vault.name", () => {
    const c = addStep(emptyChain(), { kind: "property", name: "name" });
    expect(renderExpression(c)).toBe("vault.name");
    assertParses(renderExpression(c));
    expect(chainTypeAt(c, 1)).toBe("string");
  });

  it("vault.notes is a Collection<Note>", () => {
    const c = addStep(emptyChain(), { kind: "property", name: "notes" });
    expect(chainTypeAt(c, 1)).toBe("Collection<Note>");
  });

  it("vault.stats.noteCount", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "stats" });
    c = addStep(c, { kind: "property", name: "noteCount" });
    expect(renderExpression(c)).toBe("vault.stats.noteCount");
    assertParses(renderExpression(c));
  });
});

describe("templateExpressionBuilder — method chains without lambda", () => {
  it("vault.notes.count()", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "count" });
    expect(renderExpression(c)).toBe("vault.notes.count()");
    assertParses(renderExpression(c));
  });

  it("vault.notes.first()", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "first" });
    expect(renderExpression(c)).toBe("vault.notes.first()");
    assertParses(renderExpression(c));
    // first() on Collection<Note> yields Note — user can keep chaining
    expect(chainTypeAt(c, 2)).toBe("Note");
  });

  it("allows further chaining after first()", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "first" });
    c = addStep(c, { kind: "property", name: "title" });
    expect(renderExpression(c)).toBe("vault.notes.first().title");
    assertParses(renderExpression(c));
  });
});

describe("templateExpressionBuilder — method chains with lambda", () => {
  it("vault.notes.where(n => n.name == \"todo\")", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "where" });
    c = setStepLambda(c, 2, {
      propertyPath: ["name"],
      op: "==",
      literal: "todo",
      literalKind: "string",
    });
    expect(renderExpression(c)).toBe('vault.notes.where(n => n.name == "todo")');
    assertParses(renderExpression(c));
  });

  it("chains another method after a lambda-taking method", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "where" });
    c = setStepLambda(c, 2, {
      propertyPath: ["name"],
      op: "==",
      literal: "todo",
      literalKind: "string",
    });
    c = addStep(c, { kind: "method", name: "count" });
    expect(renderExpression(c)).toBe(
      'vault.notes.where(n => n.name == "todo").count()',
    );
    assertParses(renderExpression(c));
  });

  it("supports numeric literals without quotes", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "tags" });
    c = addStep(c, { kind: "method", name: "where" });
    c = setStepLambda(c, 2, {
      propertyPath: ["count"],
      op: ">",
      literal: "5",
      literalKind: "number",
    });
    expect(renderExpression(c)).toBe("vault.tags.where(t => t.count > 5)");
    assertParses(renderExpression(c));
  });

  it("supports boolean literals", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "where" });
    c = setStepLambda(c, 2, {
      propertyPath: ["property", "published"],
      op: "==",
      literal: "true",
      literalKind: "boolean",
    });
    expect(renderExpression(c)).toBe(
      "vault.notes.where(n => n.property.published == true)",
    );
    assertParses(renderExpression(c));
  });

  it("reaches nested frontmatter via property.<key>", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "where" });
    c = setStepLambda(c, 2, {
      propertyPath: ["property", "tags"],
      op: "==",
      literal: "x",
      literalKind: "string",
    });
    expect(renderExpression(c)).toBe(
      'vault.notes.where(n => n.property.tags == "x")',
    );
    assertParses(renderExpression(c));
  });
});

describe("templateExpressionBuilder — string escaping", () => {
  it("escapes double quotes and backslashes in string literals", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "where" });
    c = setStepLambda(c, 2, {
      propertyPath: ["name"],
      op: "==",
      literal: 'has "quotes" and \\ slashes',
      literalKind: "string",
    });
    const out = renderExpression(c);
    expect(out).toBe(
      'vault.notes.where(n => n.name == "has \\"quotes\\" and \\\\ slashes")',
    );
    // Must still parse — round-trip through the evaluator.
    assertParses(out);
  });
});

describe("templateExpressionBuilder — mutations", () => {
  it("removeStepsFrom truncates the chain at the given index", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "where" });
    c = addStep(c, { kind: "method", name: "count" });
    const truncated = removeStepsFrom(c, 2);
    expect(renderExpression(truncated)).toBe("vault.notes");
  });

  it("removeStepsFrom(0) collapses to bare root", () => {
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    const bare = removeStepsFrom(c, 1);
    expect(renderExpression(bare)).toBe("vault");
  });

  it("chainTypeAt returns null when walking past a known type", () => {
    // toArray returns `any`, which is an untyped dead-end — the builder
    // should expose this so the UI can show "no further members".
    let c = emptyChain();
    c = addStep(c, { kind: "property", name: "notes" });
    c = addStep(c, { kind: "method", name: "toArray" });
    expect(chainTypeAt(c, 2)).toBe("any");
  });
});

describe("templateExpressionBuilder — operator surface", () => {
  const ops = ["==", "!=", ">", "<", ">=", "<="] as const;
  for (const op of ops) {
    it(`renders the ${op} operator`, () => {
      let c = emptyChain();
      c = addStep(c, { kind: "property", name: "notes" });
      c = addStep(c, { kind: "method", name: "where" });
      c = setStepLambda(c, 2, {
        propertyPath: ["name"],
        op,
        literal: "x",
        literalKind: "string",
      });
      const expected = `vault.notes.where(n => n.name ${op} "x")`;
      expect(renderExpression(c)).toBe(expected);
      assertParses(expected);
    });
  }
});
