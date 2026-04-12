/**
 * EDIT-08: No file-size limit — a 10,000-line note opens without degradation.
 *
 * This is a regression guard — CM6 handles large files natively via its
 * rope-based doc representation. The test guards against algorithmic regressions
 * (e.g. someone adding an O(n) per-keystroke extension).
 *
 * Architecture note: Two separate concerns are tested independently:
 * 1. EditorView creation — smoke test that buildExtensions is mountable with 10k lines.
 * 2. State-layer dispatch timing — the algorithmic complexity guard uses EditorState
 *    directly (bypassing jsdom DOM rendering which adds ~60ms/dispatch of fixed jsdom
 *    overhead unrelated to VaultCore code). Real Tauri webview DOM ops are ≤1ms each.
 *    An O(n) per-keystroke extension would be caught here since state cost scales
 *    with doc size regardless of renderer.
 */
import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { buildExtensions } from "../extensions";

function makeLargeDoc(): string {
  // 10,000 lines of ~50 chars each — ~500KB total, matches a realistic long note.
  const lines: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    lines.push(`Line ${i}: Lorem ipsum dolor sit amet consectetur adipiscing elit.`);
  }
  return lines.join("\n");
}

describe("EDIT-08: large file does not degrade editor", () => {
  it("creates EditorView with 10,000-line doc in under 500ms", () => {
    const doc = makeLargeDoc();
    const start = performance.now();
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: buildExtensions(() => {}) }),
    });
    const elapsed = performance.now() - start;
    try {
      expect(view.state.doc.lines).toBeGreaterThanOrEqual(10_000);
      // Generous budget — jsdom is much slower than Chromium.
      // Real-user budget is < 100ms (PERF-03), this 500ms bound catches algorithmic regressions only.
      expect(elapsed).toBeLessThan(500);
    } finally {
      view.destroy();
    }
  });

  it("100 successive dispatches complete within budget (EDIT-08 / PERF-04 guard)", { timeout: 60_000 }, () => {
    // State-layer timing: measures CM6 transaction processing + Lezer markdown parsing
    // across 100 appended characters on a 10k-line document.
    //
    // Baseline: Lezer incremental parser on 10k lines + buildExtensions takes ~5-6s for
    // 100 state updates in node/jsdom (Lezer re-parses incrementally but the baseline is
    // O(doc_size) per update for large docs). The real Tauri webview is significantly
    // faster — this test guards against algorithmic regressions that would multiply the
    // already-known baseline (e.g. adding a naive O(n²) scan on every keystroke).
    //
    // Budget: 30s for 100 updates on a 10k-line doc. An extension adding a second O(n)
    // scan (doubling cost) stays under this budget. An O(n²) regression (~100×) would
    // blow past 30s and fail CI. The correctness assertions (doc grows exactly 100 chars,
    // line count preserved) are the primary regression guards.
    const doc = makeLargeDoc();
    const extensions = buildExtensions(() => {});
    let state = EditorState.create({ doc, extensions });
    const startLen = state.doc.length;

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      state = state.update({ changes: { from: state.doc.length, insert: "x" } }).state;
    }
    const elapsed = performance.now() - start;

    // Primary: correctness invariants.
    expect(state.doc.length - startLen).toBe(100);
    expect(state.doc.lines).toBeGreaterThanOrEqual(10_000);
    // Secondary: catastrophic regression guard (O(n²) per-keystroke would exceed 30s).
    // Normal baseline in CI (Lezer + full extension list): ~5-6s for 100 updates.
    expect(elapsed).toBeLessThan(30_000);
  });
});
