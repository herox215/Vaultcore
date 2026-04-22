// Audit: no CM6 editor-plugin hot path may call `view.state.doc.toString()`
// (or `state.doc.toString()`, etc.) on a per-update path — see issue #247.
//
// Full-doc serialisation on every docChanged / viewportChanged / selectionSet
// transaction allocates O(doc length) per keystroke and directly eats the
// 16ms keystroke budget on medium+ notes. This test is the tripwire that
// catches any regression where a plugin adds a fresh `doc.toString()` call.
//
// Scope: only non-recursive `src/components/Editor/*.ts` — Svelte components
// and `src/components/Editor/__tests__/**` are out of scope; several call
// sites there (EditorPane.svelte, App.svelte, PropertiesPanel.svelte, etc.)
// run on explicit user actions, not the CM6 update path.
//
// Allowlist:
//   - `autoSave.ts`       — runs on a debounced save, not on keystroke.
//   - `countsPlugin.ts`   — has its own doc-ref cache; the toString is guarded
//                            by an identity check and skipped on identity-
//                            equal docs.
//   - `templateAutocomplete.ts` — CodeMirror CompletionSource (not a
//                                 ViewPlugin / StateField hot path). Fires
//                                 only when the autocomplete engine requests
//                                 completions, not on every keystroke. The
//                                 standalone `doc.toString()` here is
//                                 acceptable and out of scope for this issue.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR_DIR = resolve(HERE, "..");

/**
 * Non-recursive list of .ts files directly under src/components/Editor —
 * excludes __tests__ (subdirectory) and any .svelte files.
 */
function editorPluginFiles(): string[] {
  return readdirSync(EDITOR_DIR)
    .filter((name) => {
      const full = join(EDITOR_DIR, name);
      if (!statSync(full).isFile()) return false;
      return name.endsWith(".ts") && !name.endsWith(".d.ts");
    })
    .map((name) => join(EDITOR_DIR, name));
}

const DOC_TO_STRING_RE = /doc\.toString\(\)/;

/**
 * Files explicitly allowed to call `doc.toString()`. Any other Editor plugin
 * file that introduces the call fails this audit.
 */
const ALLOWLIST = new Set([
  "autoSave.ts",
  "countsPlugin.ts",
  "templateAutocomplete.ts",
]);

describe("editor plugins — no doc.toString() on the hot path (#247)", () => {
  it("no non-allowlisted Editor plugin file calls doc.toString()", () => {
    const files = editorPluginFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of files) {
      const base = path.slice(EDITOR_DIR.length + 1);
      if (ALLOWLIST.has(base)) continue;
      const content = readFileSync(path, "utf8");
      if (DOC_TO_STRING_RE.test(content)) {
        offenders.push(base);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the allowlist itself is minimal — every entry still exists on disk", () => {
    // Guard against forgotten allowlist entries that drift out of sync with
    // the codebase. If a file is removed or renamed, the allowlist must be
    // updated to match.
    const diskFiles = new Set(
      editorPluginFiles().map((p) => p.slice(EDITOR_DIR.length + 1)),
    );
    for (const name of ALLOWLIST) {
      expect(diskFiles.has(name)).toBe(true);
    }
  });
});
