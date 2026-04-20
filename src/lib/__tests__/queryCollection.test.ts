// Unit tests for the lazy LINQ-style Collection (#283).

import { describe, it, expect, vi } from "vitest";
import { Collection } from "../queryCollection";

describe("Collection — terminal ops", () => {
  it("toArray returns a plain array of the source", () => {
    expect(new Collection([1, 2, 3]).toArray()).toEqual([1, 2, 3]);
  });

  it("count returns the post-pipeline size", () => {
    expect(new Collection([1, 2, 3, 4]).where((n) => n % 2 === 0).count()).toBe(2);
  });

  it("first returns null on an empty collection", () => {
    expect(new Collection<number>([]).first()).toBeNull();
    expect(new Collection([1, 2]).where((n) => n > 10).first()).toBeNull();
  });

  it("any / all apply the predicate over the pipeline", () => {
    const c = new Collection([1, 2, 3]);
    expect(c.any((n) => n === 2)).toBe(true);
    expect(c.any((n) => n > 10)).toBe(false);
    expect(c.all((n) => n > 0)).toBe(true);
    expect(c.all((n) => n > 1)).toBe(false);
  });

  it("groupBy buckets by the selector key", () => {
    const c = new Collection([1, 2, 3, 4, 5]);
    const groups = c.groupBy((n) => n % 2);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.items]));
    expect(byKey[1]).toEqual([1, 3, 5]);
    expect(byKey[0]).toEqual([2, 4]);
  });

  it("join concatenates string elements with the separator", () => {
    expect(new Collection(["a", "b", "c"]).join(", ")).toBe("a, b, c");
  });

  it("join coerces non-string elements via String()", () => {
    expect(new Collection([1, 2, 3]).join("-")).toBe("1-2-3");
  });

  it("join on an empty collection returns an empty string", () => {
    expect(new Collection<string>([]).join(", ")).toBe("");
  });

  it("join with a newline separator preserves newlines verbatim", () => {
    const out = new Collection([1, 2, 3])
      .select((n) => "- " + n)
      .join("\n");
    expect(out).toBe("- 1\n- 2\n- 3");
  });

  it("join composes after where/select just like any other terminal op", () => {
    const out = new Collection([1, 2, 3, 4])
      .where((n) => n % 2 === 0)
      .select((n) => "#" + n)
      .join(" ");
    expect(out).toBe("#2 #4");
  });
});

describe("Collection — chaining", () => {
  it("where → select → take composes in pipeline order", () => {
    const out = new Collection([1, 2, 3, 4, 5, 6])
      .where((n) => n % 2 === 0)
      .select((n) => n * 10)
      .take(2)
      .toArray();
    expect(out).toEqual([20, 40]);
  });

  it("skip and take combine for paging", () => {
    const out = new Collection([1, 2, 3, 4, 5]).skip(2).take(2).toArray();
    expect(out).toEqual([3, 4]);
  });

  it("sortBy orders ascending by default", () => {
    const out = new Collection([3, 1, 2]).sortBy((n) => n).toArray();
    expect(out).toEqual([1, 2, 3]);
  });

  it("sortBy supports descending order", () => {
    const out = new Collection([{ v: 1 }, { v: 3 }, { v: 2 }])
      .sortBy((x) => x.v, "desc")
      .select((x) => x.v)
      .toArray();
    expect(out).toEqual([3, 2, 1]);
  });

  it("distinct deduplicates by identity", () => {
    const out = new Collection([1, 2, 2, 3, 3, 3]).distinct().toArray();
    expect(out).toEqual([1, 2, 3]);
  });
});

describe("Collection — laziness and early exit", () => {
  it("first() short-circuits where() before visiting all elements", () => {
    const pred = vi.fn((n: number) => n > 0);
    const c = new Collection([1, 2, 3, 4, 5]).where(pred);
    const v = c.first();
    expect(v).toBe(1);
    // Only one item needs to satisfy the predicate before first() returns.
    expect(pred).toHaveBeenCalledTimes(1);
  });

  it("first() after a sortBy materializes the sort (correctness over laziness)", () => {
    const out = new Collection([3, 1, 2]).sortBy((n) => n).first();
    expect(out).toBe(1);
  });

  it("stages do not mutate the source array", () => {
    const src = [3, 1, 2];
    new Collection(src).sortBy((n) => n).toArray();
    expect(src).toEqual([3, 1, 2]);
  });
});

describe("Collection — iterable", () => {
  it("can be consumed by for..of via Symbol.iterator", () => {
    const out: number[] = [];
    for (const n of new Collection([1, 2]).select((n) => n * 2)) out.push(n);
    expect(out).toEqual([2, 4]);
  });
});
