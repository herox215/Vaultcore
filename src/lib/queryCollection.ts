// Generic lazy collection with LINQ-style chainable operators. Backs every
// iterable surface of the vault API (`vault.notes`, `vault.tags`, ...).
//
// Laziness: `where` / `select` / `sortBy` / `take` / `skip` / `distinct`
// return a new Collection that captures the pipeline without running it.
// Materialization happens exactly once, inside a terminal op (`toArray`,
// `count`, `first`, `any`, `all`, `groupBy`). `first()` short-circuits —
// it walks the pipeline only until the first element passes every stage.
//
// This module is pure: no store reads, no frontmatter, no IPC. The vault
// API (vaultApi.ts) wraps collection results around live store reads.

export type Predicate<T> = (item: T) => boolean;
export type Selector<T, U> = (item: T) => U;
export type KeyFn<T> = (item: T) => unknown;

type Stage =
  | { kind: "where"; pred: Predicate<unknown> }
  | { kind: "select"; sel: Selector<unknown, unknown> }
  | { kind: "take"; n: number }
  | { kind: "skip"; n: number }
  | { kind: "sortBy"; key: KeyFn<unknown>; desc: boolean }
  | { kind: "distinct" };

export class Collection<T> {
  private readonly source: readonly unknown[];
  private readonly stages: readonly Stage[];

  constructor(source: Iterable<T>, stages: readonly Stage[] = []) {
    this.source =
      Array.isArray(source) ? (source as readonly unknown[]) : [...source];
    this.stages = stages;
  }

  where(pred: Predicate<T>): Collection<T> {
    return new Collection<T>(this.source as Iterable<T>, [
      ...this.stages,
      { kind: "where", pred: pred as Predicate<unknown> },
    ]);
  }

  select<U>(sel: Selector<T, U>): Collection<U> {
    return new Collection<U>(this.source as Iterable<U>, [
      ...this.stages,
      { kind: "select", sel: sel as Selector<unknown, unknown> },
    ]);
  }

  take(n: number): Collection<T> {
    return new Collection<T>(this.source as Iterable<T>, [
      ...this.stages,
      { kind: "take", n: Math.max(0, Math.trunc(n)) },
    ]);
  }

  skip(n: number): Collection<T> {
    return new Collection<T>(this.source as Iterable<T>, [
      ...this.stages,
      { kind: "skip", n: Math.max(0, Math.trunc(n)) },
    ]);
  }

  // sortBy is eager at its position in the pipeline — ordering requires
  // seeing every element before its stage. Downstream stages still stream.
  sortBy(key: KeyFn<T>, order: "asc" | "desc" = "asc"): Collection<T> {
    return new Collection<T>(this.source as Iterable<T>, [
      ...this.stages,
      { kind: "sortBy", key: key as KeyFn<unknown>, desc: order === "desc" },
    ]);
  }

  distinct(): Collection<T> {
    return new Collection<T>(this.source as Iterable<T>, [
      ...this.stages,
      { kind: "distinct" },
    ]);
  }

  // --- Terminal ops ---

  toArray(): T[] {
    return this.materialize() as T[];
  }

  count(): number {
    return this.materialize().length;
  }

  first(): T | null {
    const out = this.walkEarlyExit(1);
    return out.length > 0 ? (out[0] as T) : null;
  }

  any(pred?: Predicate<T>): boolean {
    if (!pred) return this.walkEarlyExit(1).length > 0;
    for (const item of this.materialize()) {
      if (pred(item as T)) return true;
    }
    return false;
  }

  all(pred: Predicate<T>): boolean {
    for (const item of this.materialize()) {
      if (!pred(item as T)) return false;
    }
    return true;
  }

  groupBy<K>(key: Selector<T, K>): { key: K; items: T[] }[] {
    const map = new Map<K, T[]>();
    for (const item of this.materialize()) {
      const k = key(item as T);
      const bucket = map.get(k);
      if (bucket) bucket.push(item as T);
      else map.set(k, [item as T]);
    }
    return [...map.entries()].map(([k, items]) => ({ key: k, items }));
  }

  [Symbol.iterator](): Iterator<T> {
    return (this.materialize() as T[])[Symbol.iterator]();
  }

  // --- Internals ---

  private materialize(): unknown[] {
    return this.run(this.stages);
  }

  // Walks the pipeline until `limit` outputs are produced. Used by `first()`
  // and `any()` to avoid materializing the whole dataset when a sort stage
  // is absent. If a sort stage exists, it must still consume everything up
  // to it (unavoidable), but downstream stages still stream.
  private walkEarlyExit(limit: number): unknown[] {
    return this.run(this.stages, limit);
  }

  private run(stages: readonly Stage[], limit = Infinity): unknown[] {
    // If any stage is order-dependent (sortBy) or bulk-only (distinct), we
    // fall back to full materialisation since early-exit would change results.
    const hasBulkStage = stages.some(
      (s) => s.kind === "sortBy" || s.kind === "distinct" || s.kind === "skip",
    );
    if (limit === Infinity || hasBulkStage) {
      let items: unknown[] = this.source as unknown[];
      for (const stage of stages) items = applyStage(items, stage);
      return limit === Infinity ? items : items.slice(0, limit);
    }
    // Streaming path: only where/select/take. Walk the source one item at
    // a time and apply the pipeline; stop once we've produced `limit` items.
    // This keeps `first()` / `any()` short-circuiting even when downstream
    // predicates are expensive.
    const out: unknown[] = [];
    let taken = 0;
    let takeCap = Infinity;
    for (const stage of stages) {
      if (stage.kind === "take") takeCap = Math.min(takeCap, stage.n);
    }
    const cap = Math.min(limit, takeCap);
    outer: for (const item of this.source) {
      let cur: unknown = item;
      for (const stage of stages) {
        if (stage.kind === "where") {
          if (!stage.pred(cur)) continue outer;
        } else if (stage.kind === "select") {
          cur = stage.sel(cur);
        }
        // `take` is enforced by cap; skip/sortBy/distinct never reach here.
      }
      out.push(cur);
      taken++;
      if (taken >= cap) break;
    }
    return out;
  }
}

function applyStage(items: unknown[], stage: Stage): unknown[] {
  switch (stage.kind) {
    case "where":
      return items.filter(stage.pred);
    case "select":
      return items.map(stage.sel);
    case "take":
      return items.slice(0, stage.n);
    case "skip":
      return items.slice(stage.n);
    case "sortBy": {
      const sign = stage.desc ? -1 : 1;
      return [...items].sort((a, b) => {
        const ka = stage.key(a);
        const kb = stage.key(b);
        if (ka === kb) return 0;
        if (ka == null) return 1;
        if (kb == null) return -1;
        if ((ka as number | string) < (kb as number | string)) return -1 * sign;
        if ((ka as number | string) > (kb as number | string)) return 1 * sign;
        return 0;
      });
    }
    case "distinct": {
      const seen = new Set<unknown>();
      const out: unknown[] = [];
      for (const item of items) {
        if (!seen.has(item)) {
          seen.add(item);
          out.push(item);
        }
      }
      return out;
    }
  }
}

export function isCollection(v: unknown): v is Collection<unknown> {
  return v instanceof Collection;
}
