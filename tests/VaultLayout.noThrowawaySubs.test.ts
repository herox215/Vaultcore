// Issue #259 regression guard.
//
// `VaultLayout.svelte` previously had a pattern like
//
//   const unsub = vaultStore.subscribe(v => { vaultPath = v.currentPath; });
//   unsub();
//
// inside per-keystroke `tabStore` subscription callbacks. `tabStore` fires on
// every `setDirty`, scroll, and cursor update, so this allocated a fresh
// closure and ran the full subscriber cycle on every keystroke.
//
// The fix replaces those immediate-throwaway subscribes with `get(store)`
// reads (or equivalent non-allocating snapshots). This test pins the source
// of `VaultLayout.svelte` so the antipattern can't sneak back in.
//
// AC from the issue:
//   "No subscribe(...).unsubscribe() immediate-throwaway pattern in
//    VaultLayout.svelte (enforced by grep rule or review)."

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LAYOUT_PATH = resolve(
  __dirname,
  "../src/components/Layout/VaultLayout.svelte",
);

describe("Issue #259: VaultLayout has no throwaway subscribe/unsub pattern", () => {
  const src = readFileSync(LAYOUT_PATH, "utf8");

  it("does not contain `const <name> = <store>.subscribe(...)` followed by an immediate `<name>()`", () => {
    // Walk every `const <name> = <something>Store.subscribe(` occurrence,
    // brace-balance across the arrow body + the closing paren, and check
    // whether the very next non-trivial token is `<name>()`. We look for the
    // specific shape the issue calls out, not any subscribe at all — long-
    // lived subscriptions stored in `unsub*` variables and cleaned up in
    // `onDestroy` are fine.
    const starter = /const\s+(\w+)\s*=\s*\w+Store\.subscribe\s*\(/g;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = starter.exec(src)) !== null) {
      const name = m[1];
      // Walk from the opening `(` of `.subscribe(` to its matching `)`.
      let i = m.index + m[0].length; // points just past the opening `(`
      let parenDepth = 1;
      let braceDepth = 0;
      while (i < src.length && parenDepth > 0) {
        const ch = src[i];
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
        else if (ch === "(" && braceDepth === 0) parenDepth++;
        else if (ch === ")" && braceDepth === 0) parenDepth--;
        i++;
      }
      // Skip optional `;` then whitespace.
      if (src[i] === ";") i++;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      const tail = src.slice(i, i + name.length + 4);
      if (new RegExp(`^${name}\\s*\\(\\s*\\)`).test(tail)) {
        offenders.push(src.slice(m.index, i + name.length + 4));
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `Found throwaway subscribe/unsub antipattern(s):\n${offenders.join("\n---\n")}`
        : "",
    ).toEqual([]);
  });

  it("does not call `.subscribe(` inside a `tabStore.subscribe(` callback body", () => {
    // Per-keystroke hot path guard: the tabStore subscription callback must
    // not open a fresh subscription on another store. Scan each
    // `tabStore.subscribe((state) => { ... })` body and assert no nested
    // `.subscribe(` appears. Matches both this specific file's shape and
    // any future regression that re-introduces it.
    const callbackBodies = extractTabStoreCallbackBodies(src);
    expect(callbackBodies.length).toBeGreaterThan(0); // sanity: we do have tabStore subs
    for (const body of callbackBodies) {
      expect(
        body.includes(".subscribe("),
        `tabStore.subscribe callback body contains a nested .subscribe( call:\n${body}`,
      ).toBe(false);
    }
  });
});

/**
 * Extract the body (text between the outermost `{` and matching `}`) of every
 * `tabStore.subscribe((...args) => { ... })` arrow callback in the given
 * source. Naive but adequate for this codebase — VaultLayout uses arrow
 * functions with balanced braces and no unbalanced braces in string literals
 * inside those bodies.
 */
function extractTabStoreCallbackBodies(src: string): string[] {
  const bodies: string[] = [];
  const starter = /tabStore\.subscribe\s*\(\s*\(?[^)]*\)?\s*=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = starter.exec(src)) !== null) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth === 0) {
      bodies.push(src.slice(bodyStart, i - 1));
    }
  }
  return bodies;
}
