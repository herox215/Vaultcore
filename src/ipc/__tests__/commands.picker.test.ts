// #391 — picker IPC wrappers must hit the Rust commands `pick_vault_folder`
// and `pick_save_path` with the documented payloads, and propagate `null`
// (cancellation) without translating it to undefined / "" / errors.
//
// The cancellation-as-null contract is load-bearing: every caller branches
// on `picked === null` to short-circuit silently. A wrapper that turned
// null into "" or threw would make every save/open flow fall through into
// the success path and crash downstream.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { pickVaultFolder, pickSavePath } from "../commands";

describe("pickVaultFolder", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("invokes pick_vault_folder with no payload", async () => {
    invoke.mockResolvedValueOnce("/Users/lu/MyVault");
    const out = await pickVaultFolder();
    expect(invoke).toHaveBeenCalledWith("pick_vault_folder");
    expect(out).toBe("/Users/lu/MyVault");
  });

  it("propagates null on cancellation (no coercion)", async () => {
    invoke.mockResolvedValueOnce(null);
    const out = await pickVaultFolder();
    expect(out).toBeNull();
  });

  it("returns the opaque URI string verbatim on Android (content://)", async () => {
    invoke.mockResolvedValueOnce(
      "content://com.android.externalstorage.documents/tree/primary%3AVault",
    );
    const out = await pickVaultFolder();
    expect(out).toBe("content://com.android.externalstorage.documents/tree/primary%3AVault");
  });
});

describe("pickSavePath", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("invokes pick_save_path with defaultName + filters payload", async () => {
    invoke.mockResolvedValueOnce("/Users/lu/Desktop/note.html");
    const filters = [{ name: "HTML", extensions: ["html", "htm"] }];
    const out = await pickSavePath("note.html", filters);
    expect(invoke).toHaveBeenCalledWith("pick_save_path", { defaultName: "note.html", filters });
    expect(out).toBe("/Users/lu/Desktop/note.html");
  });

  it("defaults filters to [] when omitted", async () => {
    invoke.mockResolvedValueOnce("/tmp/x.bin");
    await pickSavePath("x.bin");
    expect(invoke).toHaveBeenCalledWith("pick_save_path", { defaultName: "x.bin", filters: [] });
  });

  it("propagates null on cancellation", async () => {
    invoke.mockResolvedValueOnce(null);
    const out = await pickSavePath("note.html", []);
    expect(out).toBeNull();
  });
});
