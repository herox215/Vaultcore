/**
 * UI-06: All user-facing surfaces use the unified toast/dialog component.
 *
 * This test is a regression guard: no inline alert() / confirm() may be introduced
 * without a deliberate refactor. Every error/merge/rename/delete notice goes
 * through toastStore.push or a dialog component.
 */
/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const EXCLUDE_DIRS = new Set(["node_modules", "__tests__", "dist"]);
const INCLUDE_EXT = [".ts", ".tsx", ".svelte"];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (INCLUDE_EXT.some((e) => name.endsWith(e))) out.push(full);
  }
}

// Regex allows leading whitespace/paren/= but forbids a `.` right before the keyword
// (so toastStore.alert or custom.alert-free-of-window would not false-match).
const ALERT_RE = /(?:^|[^a-zA-Z_.])(?:window\.)?(alert|confirm)\s*\(/;

describe("UI-06 audit (regression guard)", () => {
  it("no inline alert() / confirm() anywhere in src/", () => {
    const files: string[] = [];
    walk(SRC, files);
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      // Strip single-line // comments and block /* */ comments to avoid false positives
      const stripped = content
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (ALERT_RE.test(stripped)) {
        offenders.push(f);
      }
    }
    expect(
      offenders,
      `UI-06 violation: inline alert/confirm detected in:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every toastStore.push call passes an object with variant + message", () => {
    const files: string[] = [];
    walk(SRC, files);
    const violations: string[] = [];
    for (const f of files) {
      if (f.endsWith("toastStore.ts")) continue; // skip the store itself
      const content = readFileSync(f, "utf8");
      const pushCalls = content.match(/toastStore\.push\s*\(\s*[^)]*\)/gs) ?? [];
      for (const call of pushCalls) {
        // Must contain both `variant:` and `message:` — allow any surrounding whitespace
        if (!/variant\s*:/.test(call) || !/message\s*:/.test(call)) {
          violations.push(`${f}: ${call.slice(0, 80)}`);
        }
      }
    }
    expect(
      violations,
      `UI-06 violation: toastStore.push without variant+message:\n${violations.join("\n")}`
    ).toEqual([]);
  });
});
