import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

// Must mock the IPC module BEFORE importing tagsStore.
vi.mock("../../ipc/commands", () => ({
  listTags: vi.fn(),
}));

import { listTags } from "../../ipc/commands";
import { tagsStore } from "../tagsStore";

describe("tagsStore (TAG-03)", () => {
  beforeEach(() => { tagsStore.reset(); vi.clearAllMocks(); });

  it("initial state is empty", () => {
    expect(get(tagsStore)).toEqual({ tags: [], loading: false, error: null });
  });

  it("reload() populates tags from listTags()", async () => {
    (listTags as any).mockResolvedValueOnce([{ tag: "rust", count: 12 }, { tag: "svelte", count: 3 }]);
    await tagsStore.reload();
    const s = get(tagsStore);
    expect(s.tags).toHaveLength(2);
    expect(s.tags[0]).toEqual({ tag: "rust", count: 12 });
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("reload() surfaces VaultError via vaultErrorCopy", async () => {
    (listTags as any).mockRejectedValueOnce({ kind: "Io", message: "boom", data: null });
    await tagsStore.reload();
    const s = get(tagsStore);
    expect(s.loading).toBe(false);
    expect(s.error).not.toBeNull();
    expect(s.tags).toEqual([]);
  });

  it("reset() clears error and tags", async () => {
    (listTags as any).mockResolvedValueOnce([{ tag: "x", count: 1 }]);
    await tagsStore.reload();
    tagsStore.reset();
    expect(get(tagsStore)).toEqual({ tags: [], loading: false, error: null });
  });
});
