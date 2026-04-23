// Regression coverage for the "falsely reports external edit" bug.
//
// Two causes conspire to make the autosave merge-branch fire when the user
// hasn't actually edited in another tool:
//   1. Our own write slipping past the 500ms WriteIgnoreList TTL on slow
//      saves, producing a self-triggered modify event with byte-identical
//      disk content.
//   2. The previous handler never refreshed `lastSavedHash` after a merge,
//      so the next autosave compared a stale expected-hash against the
//      fresh disk hash and re-entered the merge path.
//
// decideExternalModifyAction owns both fixes: the byte-identical shortcut
// (kind: "sync-hash") and the always-return-diskHash contract so callers
// can refresh the tracker in every branch.

import { describe, it, expect, vi } from "vitest";
import {
  decideExternalModifyAction,
  sha256Hex,
} from "../externalChangeHandler";

function makeDeps(overrides: {
  diskHash: string;
  editorHash: string;
  mergeOutcome?: "clean" | "conflict";
  mergedContent?: string;
  mergeNewHash?: string | null;
}) {
  const getFileHash = vi.fn().mockResolvedValue(overrides.diskHash);
  const sha256 = vi.fn().mockResolvedValue(overrides.editorHash);
  const mergeExternalChange = vi.fn().mockResolvedValue({
    outcome: overrides.mergeOutcome ?? "clean",
    merged_content: overrides.mergedContent ?? "",
    new_hash: overrides.mergeNewHash ?? null,
  });
  return {
    getFileHash,
    sha256Hex: sha256,
    mergeExternalChange,
    _mocks: { getFileHash, sha256, mergeExternalChange },
  };
}

describe("decideExternalModifyAction", () => {
  it("returns sync-hash and skips merge when disk is byte-identical to the editor", async () => {
    // Self-write that slipped past WriteIgnoreList OR external tool touched
    // the file without changing content (git checkout same commit, Spotlight
    // metadata write). Must NOT trigger the merge RPC or a toast.
    const deps = makeDeps({ diskHash: "aa", editorHash: "aa" });

    const action = await decideExternalModifyAction(deps, {
      path: "/v/a.md",
      editorContent: "hello",
      lastSavedContent: "hello",
    });

    expect(action).toEqual({ kind: "sync-hash", diskHash: "aa" });
    expect(deps._mocks.mergeExternalChange).not.toHaveBeenCalled();
  });

  it("returns clean-merge with the backend's new_hash so lastSavedHash tracks disk", async () => {
    // #339: the backend writes merged bytes itself and returns new_hash.
    // The pre-merge `diskHash` is stale — we MUST prefer new_hash so the
    // next autosave doesn't re-enter the merge path against a phantom
    // hash mismatch.
    const deps = makeDeps({
      diskHash: "bb", // external content hash BEFORE merge
      editorHash: "aa",
      mergeOutcome: "clean",
      mergedContent: "merged!",
      mergeNewHash: "dd", // hash of merged bytes AFTER backend wrote
    });

    const action = await decideExternalModifyAction(deps, {
      path: "/v/a.md",
      editorContent: "local",
      lastSavedContent: "base",
    });

    expect(action).toEqual({
      kind: "clean-merge",
      mergedContent: "merged!",
      diskHash: "dd", // NOT "bb" — new_hash wins
    });
    expect(deps._mocks.mergeExternalChange).toHaveBeenCalledWith(
      "/v/a.md",
      "local",
      "base",
    );
  });

  it("falls back to hashing merged_content when new_hash is missing", async () => {
    // Defence against an older backend that doesn't populate new_hash.
    // Must NOT use the pre-merge diskHash — it reflects external content,
    // not the merged bytes the backend wrote (or would have written).
    const deps = makeDeps({
      diskHash: "bb",
      editorHash: "aa",
      mergeOutcome: "clean",
      mergedContent: "merged!",
      mergeNewHash: null,
    });
    // Force sha256Hex to distinguish its two call sites: the first call
    // (editor hash, up front) returns "aa"; the second (fallback) returns
    // the hash of mergedContent.
    deps._mocks.sha256
      .mockResolvedValueOnce("aa")
      .mockResolvedValueOnce("computed-merged-hash");

    const action = await decideExternalModifyAction(deps, {
      path: "/v/a.md",
      editorContent: "local",
      lastSavedContent: "base",
    });

    expect(action).toEqual({
      kind: "clean-merge",
      mergedContent: "merged!",
      diskHash: "computed-merged-hash",
    });
  });

  it("returns conflict with the fresh disk hash so the next autosave is unambiguous", async () => {
    // Contract: on conflict the editor keeps local content but the caller
    // MUST record diskHash — otherwise the next autosave will re-enter the
    // merge branch against a stale expected hash and surface the phantom
    // "external edit" toast again.
    const deps = makeDeps({
      diskHash: "cc",
      editorHash: "aa",
      mergeOutcome: "conflict",
      mergedContent: "ignored",
    });

    const action = await decideExternalModifyAction(deps, {
      path: "/v/a.md",
      editorContent: "local",
      lastSavedContent: "base",
    });

    expect(action).toEqual({ kind: "conflict", diskHash: "cc" });
  });

  it("does not read disk twice — getFileHash and sha256Hex run in parallel", async () => {
    // Guard against a regression that would serialize the two hashes and
    // double end-to-end latency of every modify event.
    const order: string[] = [];
    const getFileHash = vi.fn().mockImplementation(async () => {
      order.push("getFileHash:start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("getFileHash:end");
      return "aa";
    });
    const sha256 = vi.fn().mockImplementation(async () => {
      order.push("sha256:start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("sha256:end");
      return "aa";
    });

    await decideExternalModifyAction(
      {
        getFileHash,
        sha256Hex: sha256,
        mergeExternalChange: vi.fn(),
      },
      { path: "/v/a.md", editorContent: "x", lastSavedContent: "x" },
    );

    // Both starts happen before either end → parallel.
    expect(order.slice(0, 2).sort()).toEqual([
      "getFileHash:start",
      "sha256:start",
    ]);
  });
});

describe("sha256Hex", () => {
  // The backend uses `hash_bytes` = lowercase hex of Sha256::digest(bytes).
  // The frontend equality shortcut depends on producing the exact same
  // string. NIST known-answer vectors:
  it("matches the NIST empty-input vector", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known 'hello' vector used in the Rust hash tests", async () => {
    expect(await sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
