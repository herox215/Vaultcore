// #261 — the recents derivation must be cheap + stable so the OmniSearch
// subscriber can short-circuit when the tabStore emits a change that
// doesn't actually affect the recents list (dirty flag flipping,
// scrollPos updates, lastSavedHash writes, ...).

import { describe, it, expect } from "vitest";
import { computeRecentFiles, recentsSignature } from "../recentFiles";

describe("recentFiles (#261)", () => {
  it("dedupes by filePath and walks tabs in reverse", () => {
    const tabs = [
      { filePath: "/v/a.md" },
      { filePath: "/v/b.md" },
      { filePath: "/v/c.md" },
      { filePath: "/v/a.md" }, // reopened — already seen on reverse pass
    ];
    const r = computeRecentFiles(tabs);
    // Reverse-walk dedupe: [a, c, b]
    expect(r.map((x) => x.path)).toEqual(["/v/a.md", "/v/c.md", "/v/b.md"]);
  });

  it("caps the result at the given limit", () => {
    const tabs = Array.from({ length: 20 }, (_, i) => ({ filePath: `/v/f${i}.md` }));
    const r = computeRecentFiles(tabs, 8);
    expect(r.length).toBe(8);
  });

  it("exposes filename as the last path segment", () => {
    const r = computeRecentFiles([{ filePath: "/v/sub/note.md" }]);
    expect(r[0]!.filename).toBe("note.md");
  });

  it("recentsSignature is stable when only non-path fields change on the tab objects", () => {
    const base = [
      { filePath: "/v/a.md", isDirty: false, scrollPos: 0, lastSavedHash: null },
      { filePath: "/v/b.md", isDirty: false, scrollPos: 0, lastSavedHash: null },
    ];
    const sig1 = recentsSignature(base);

    // Simulate the tabStore publishing a new state object with per-tab
    // fields mutated but filePaths unchanged.
    const churned = [
      { filePath: "/v/a.md", isDirty: true, scrollPos: 142, lastSavedHash: "abc" },
      { filePath: "/v/b.md", isDirty: false, scrollPos: 3, lastSavedHash: "xyz" },
    ];
    const sig2 = recentsSignature(churned);

    expect(sig2).toBe(sig1);
  });

  it("recentsSignature changes when a filePath changes", () => {
    const sig1 = recentsSignature([{ filePath: "/v/a.md" }]);
    const sig2 = recentsSignature([{ filePath: "/v/b.md" }]);
    expect(sig2).not.toBe(sig1);
  });

  it("recentsSignature changes when the tab order shifts (new activation)", () => {
    const sig1 = recentsSignature([{ filePath: "/v/a.md" }, { filePath: "/v/b.md" }]);
    const sig2 = recentsSignature([{ filePath: "/v/b.md" }, { filePath: "/v/a.md" }]);
    expect(sig2).not.toBe(sig1);
  });
});
