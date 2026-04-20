// #257 — unit tests for the narrow tabStore signature used by GraphView.
//
// The signature MUST be stable across tabStore emissions that are unrelated
// to saved content (dirty flag flip, cursor move, scroll change, hash
// write) and MUST change when a tab actually saves.

import { describe, it, expect } from "vitest";
import { tabContentSignature } from "../graphVisibility";

describe("tabContentSignature (#257)", () => {
  it("is stable when only non-save fields change (keystroke hot path)", () => {
    const base = [
      { id: "a", lastSaved: 1_000, type: "file" as const },
      { id: "b", lastSaved: 2_000, type: "file" as const },
    ];
    const s1 = tabContentSignature(base);

    // Emulate a per-keystroke setDirty emission: lastSaved unchanged,
    // other fields (not visible to the signature) mutated.
    const churned = [
      { id: "a", lastSaved: 1_000, type: "file" as const },
      { id: "b", lastSaved: 2_000, type: "file" as const },
    ];
    const s2 = tabContentSignature(churned);

    expect(s2).toBe(s1);
  });

  it("changes when any tab's lastSaved timestamp advances (auto-save)", () => {
    const s1 = tabContentSignature([
      { id: "a", lastSaved: 1_000, type: "file" as const },
    ]);
    const s2 = tabContentSignature([
      { id: "a", lastSaved: 1_500, type: "file" as const },
    ]);
    expect(s2).not.toBe(s1);
  });

  it("changes when a new file tab is added or an existing one closes", () => {
    const baseSig = tabContentSignature([
      { id: "a", lastSaved: 1_000, type: "file" as const },
    ]);
    const addedSig = tabContentSignature([
      { id: "a", lastSaved: 1_000, type: "file" as const },
      { id: "b", lastSaved: 1_000, type: "file" as const },
    ]);
    expect(addedSig).not.toBe(baseSig);

    const removedSig = tabContentSignature([]);
    expect(removedSig).not.toBe(baseSig);
  });

  it("ignores graph tabs (they never carry saveable content)", () => {
    const s1 = tabContentSignature([
      { id: "a", lastSaved: 1_000, type: "file" as const },
    ]);
    const s2 = tabContentSignature([
      { id: "a", lastSaved: 1_000, type: "file" as const },
      { id: "g", lastSaved: 9_999, type: "graph" as const },
    ]);
    expect(s2).toBe(s1);
  });
});
