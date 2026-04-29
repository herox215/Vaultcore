/**
 * #62 — the WIKI_EMBED_RE regex must capture (target, heading?, blockId?,
 * sizing?). These tests exercise every legal combination and pin the
 * capture-group positions so the buildDecorations consumer keeps reading
 * the right index.
 *
 * The regex itself is module-internal; the test imports the source file as
 * raw text and rebuilds the regex from the literal. This avoids exporting
 * a test-only handle while still locking down behaviour.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../embedPlugin.ts"),
  "utf-8",
);

function extractRegex(): RegExp {
  // Anchor on the comment block + the line that defines WIKI_EMBED_RE so the
  // wrong literal isn't matched if another regex is added later.
  const m = SOURCE.match(/const WIKI_EMBED_RE = (\/[^/]+\/g);/);
  if (!m || !m[1]) throw new Error("WIKI_EMBED_RE not found in source");
  // eslint-disable-next-line no-eval
  return eval(m[1]) as RegExp;
}

const RE = extractRegex();

function execAll(re: RegExp, input: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) out.push(m);
  return out;
}

describe("WIKI_EMBED_RE captures", () => {
  it("plain note embed", () => {
    const m = execAll(RE, "![[Note]]")[0]!;
    expect(m[1]).toBe("Note");
    expect(m[2]).toBeUndefined();
    expect(m[3]).toBeUndefined();
    expect(m[4]).toBeUndefined();
  });

  it("heading embed", () => {
    const m = execAll(RE, "![[Note#Section]]")[0]!;
    expect(m[1]).toBe("Note");
    expect(m[2]).toBe("Section");
    expect(m[3]).toBeUndefined();
    expect(m[4]).toBeUndefined();
  });

  it("block embed", () => {
    const m = execAll(RE, "![[Note^para1]]")[0]!;
    expect(m[1]).toBe("Note");
    expect(m[2]).toBeUndefined();
    expect(m[3]).toBe("para1");
    expect(m[4]).toBeUndefined();
  });

  it("heading + sizing", () => {
    const m = execAll(RE, "![[Note#Section|300]]")[0]!;
    expect(m[1]).toBe("Note");
    expect(m[2]).toBe("Section");
    expect(m[3]).toBeUndefined();
    expect(m[4]).toBe("300");
  });

  it("block + alias", () => {
    const m = execAll(RE, "![[Note^id|caption]]")[0]!;
    expect(m[1]).toBe("Note");
    expect(m[2]).toBeUndefined();
    expect(m[3]).toBe("id");
    expect(m[4]).toBe("caption");
  });

  it("plain image embed with sizing keeps capture 4", () => {
    const m = execAll(RE, "![[image.png|300]]")[0]!;
    expect(m[1]).toBe("image.png");
    expect(m[2]).toBeUndefined();
    expect(m[3]).toBeUndefined();
    expect(m[4]).toBe("300");
  });

  it("does not falsely match a wiki-link without `!`", () => {
    expect(execAll(RE, "[[Note^id]]")).toHaveLength(0);
  });
});
