/**
 * treeRevealStore tests — one-shot reveal signal shape, dedup via token.
 *
 * The store is consumed by Sidebar (which expands ancestors) and TreeNode
 * (which auto-expands / scrolls into view). These tests only cover the
 * store contract; component-level behaviour is exercised in the Svelte
 * integration tests.
 */
import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { treeRevealStore } from "../treeRevealStore";

describe("treeRevealStore", () => {
  it("starts with no pending request", () => {
    // Clear any lingering request from another test run
    treeRevealStore.clearPending();
    expect(get(treeRevealStore).pending).toBeNull();
  });

  it("requestReveal sets a pending request with the given rel path", () => {
    treeRevealStore.requestReveal("Projects/Work/notes");
    const s = get(treeRevealStore);
    expect(s.pending).not.toBeNull();
    expect(s.pending?.relPath).toBe("Projects/Work/notes");
    expect(typeof s.pending?.token).toBe("string");
    expect(s.pending?.token.length).toBeGreaterThan(0);
  });

  it("each requestReveal issues a fresh token", () => {
    treeRevealStore.requestReveal("a");
    const first = get(treeRevealStore).pending?.token;
    treeRevealStore.requestReveal("a"); // same path
    const second = get(treeRevealStore).pending?.token;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it("clearPending drops the pending request", () => {
    treeRevealStore.requestReveal("x");
    expect(get(treeRevealStore).pending).not.toBeNull();
    treeRevealStore.clearPending();
    expect(get(treeRevealStore).pending).toBeNull();
  });
});
