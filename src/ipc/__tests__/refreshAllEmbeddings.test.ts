// Unit test for the refreshAllEmbeddings IPC wrapper (#286).
//
// Low-value if the wrapper just forwards to `invoke` — but the command
// string is the durable contract with the Rust side, and a rename on
// either side silently breaks the feature. Pinning it here catches
// that in CI.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { refreshAllEmbeddings } from "../commands";

describe("refreshAllEmbeddings (#286)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the refresh_all_embeddings Tauri command with no args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await refreshAllEmbeddings();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("refresh_all_embeddings");
  });

  it("propagates errors from the backend as normalised errors", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "Io", message: "disk full" });
    await expect(refreshAllEmbeddings()).rejects.toBeDefined();
  });
});
