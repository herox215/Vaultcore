// Unit tests for the expression parser + safe evaluator (#283).

import { describe, it, expect } from "vitest";
import {
  evaluate,
  parse,
  renderValue,
  ExprError,
} from "../templateExpression";
import { Collection } from "../queryCollection";

describe("evaluate — primitives", () => {
  it("evaluates number/string/boolean/null literals", () => {
    expect(evaluate("42", {})).toBe(42);
    expect(evaluate("3.14", {})).toBe(3.14);
    expect(evaluate('"hi"', {})).toBe("hi");
    expect(evaluate("'x'", {})).toBe("x");
    expect(evaluate("true", {})).toBe(true);
    expect(evaluate("false", {})).toBe(false);
    expect(evaluate("null", {})).toBeNull();
  });

  it("evaluates arithmetic with correct precedence", () => {
    expect(evaluate("1 + 2 * 3", {})).toBe(7);
    expect(evaluate("(1 + 2) * 3", {})).toBe(9);
    expect(evaluate("10 / 4", {})).toBe(2.5);
    expect(evaluate("10 % 3", {})).toBe(1);
  });

  it("evaluates comparison and equality", () => {
    expect(evaluate('"a" == "a"', {})).toBe(true);
    expect(evaluate("1 != 2", {})).toBe(true);
    expect(evaluate("1 < 2 && 2 < 3", {})).toBe(true);
    expect(evaluate("1 > 2 || 2 > 1", {})).toBe(true);
  });

  it("evaluates unary ! and -", () => {
    expect(evaluate("!true", {})).toBe(false);
    expect(evaluate("-5", {})).toBe(-5);
    expect(evaluate("!!null", {})).toBe(false);
  });

  it("evaluates conditional (ternary)", () => {
    expect(evaluate("1 == 1 ? 'yes' : 'no'", {})).toBe("yes");
    expect(evaluate("1 == 2 ? 'yes' : 'no'", {})).toBe("no");
  });

  it("string concatenation via +", () => {
    expect(evaluate("'a' + 'b'", {})).toBe("ab");
    expect(evaluate("'n=' + 3", {})).toBe("n=3");
  });
});

describe("evaluate — identifier scoping", () => {
  it("resolves identifiers from the provided scope", () => {
    expect(evaluate("x + 1", { x: 41 })).toBe(42);
  });

  it("throws on unknown identifiers — no silent undefined", () => {
    expect(() => evaluate("missing", {})).toThrow(ExprError);
    expect(() => evaluate("vault.name", {})).toThrow(/vault/);
  });

  it("does NOT allow access to global built-ins", () => {
    expect(() => evaluate("Math", {})).toThrow(/Math/);
    expect(() => evaluate("globalThis", {})).toThrow(/globalThis/);
    expect(() => evaluate("console", {})).toThrow(/console/);
  });
});

describe("evaluate — member access security", () => {
  const obj = { name: "foo", nested: { v: 1 } };

  it("reads plain object properties", () => {
    expect(evaluate("o.name", { o: obj })).toBe("foo");
    expect(evaluate("o.nested.v", { o: obj })).toBe(1);
  });

  it("rejects __proto__ access", () => {
    expect(() => evaluate("o.__proto__", { o: obj })).toThrow(/not allowed/);
  });

  it("rejects constructor access", () => {
    expect(() => evaluate("o.constructor", { o: obj })).toThrow(/not allowed/);
  });

  it("rejects prototype access", () => {
    expect(() => evaluate("o.prototype", { o: obj })).toThrow(/not allowed/);
  });

  it("rejects __proto__ via computed access", () => {
    expect(() => evaluate("o['__proto__']", { o: obj })).toThrow(/not allowed/);
  });

  it("does not expose Object.prototype.hasOwnProperty as a method", () => {
    expect(() => evaluate("o.hasOwnProperty('name')", { o: obj })).toThrow(
      /not callable/,
    );
  });
});

describe("evaluate — calls and arrow functions", () => {
  it("invokes methods on the provided object", () => {
    const coll = new Collection([1, 2, 3]);
    expect(evaluate("c.count()", { c: coll })).toBe(3);
    expect(evaluate("c.first()", { c: coll })).toBe(1);
  });

  it("passes arrow functions to where/select chains", () => {
    const coll = new Collection([
      { n: "a", v: 1 },
      { n: "b", v: 2 },
      { n: "c", v: 3 },
    ]);
    const out = evaluate(
      "c.where(x => x.v > 1).select(x => x.n).toArray()",
      { c: coll },
    );
    expect(out).toEqual(["b", "c"]);
  });

  it("supports parenthesized single-param arrow `(x) => ...`", () => {
    const out = evaluate("c.where((x) => x > 1).toArray()", {
      c: new Collection([1, 2, 3]),
    });
    expect(out).toEqual([2, 3]);
  });

  it("throws on calls to non-callable values", () => {
    expect(() => evaluate("o.name()", { o: { name: "x" } })).toThrow(
      /not callable/,
    );
  });
});

describe("parse — grammar errors", () => {
  it("rejects trailing garbage", () => {
    expect(() => parse("1 + 2 garbage")).toThrow(ExprError);
  });

  it("rejects unterminated strings", () => {
    expect(() => parse('"oops')).toThrow(ExprError);
  });

  it("rejects unexpected characters", () => {
    expect(() => parse("1 @ 2")).toThrow(ExprError);
  });
});

describe("evaluate — runtime budget", () => {
  it("aborts when op count exceeds the budget", () => {
    // A deeply nested chain of binary ops that can balloon the op counter.
    // We construct enough nodes to exceed MAX_OPS (10k).
    const src = "1" + " + 1".repeat(20_000);
    expect(() => evaluate(src, {})).toThrow(/budget/);
  });
});

describe("renderValue — serialization", () => {
  it("renders primitives via String()", () => {
    expect(renderValue(42)).toBe("42");
    expect(renderValue("hi")).toBe("hi");
    expect(renderValue(true)).toBe("true");
    expect(renderValue(null)).toBe("null");
  });

  it("renders a Collection as `Collection<T>[n]`", () => {
    const c = new Collection([
      { __typeName: "Note", __id: "a" } as unknown,
      { __typeName: "Note", __id: "b" } as unknown,
    ]);
    expect(renderValue(c)).toBe("Collection<Note>[2]");
  });

  it("renders typed objects as `TypeName(id)`", () => {
    expect(renderValue({ __typeName: "Note", __id: "foo.md" })).toBe(
      'Note("foo.md")',
    );
  });

  it("renders array results comma-separated", () => {
    expect(renderValue(["a", "b", "c"])).toBe("a, b, c");
  });
});
