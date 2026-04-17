// Regression test for issue #121: the prop that tells InlineRename this is
// a freshly-created file must flow from TreeNode so the cleanup branches
// (delete the empty file on Escape/rename error) can actually fire. Before
// the fix, TreeNode passed `isNewEntry` while InlineRename declared
// `isNewFile`, leaving `isNewFile` permanently `false`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import { renameFile, deleteFile } from "../../../ipc/commands";
import InlineRename from "../InlineRename.svelte";

const OLD_PATH = "/tmp/vault/Untitled.md";

function baseProps(overrides: { isNewFile?: boolean } = {}) {
  return {
    currentName: "Untitled.md",
    oldPath: OLD_PATH,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe("InlineRename cleanup for new files (#121)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the pending file when Escape is pressed with isNewFile=true", async () => {
    const onCancel = vi.fn();
    const { container } = render(InlineRename, {
      props: { ...baseProps({ isNewFile: true }), onCancel },
    });

    const input = container.querySelector(".vc-rename-input") as HTMLInputElement;
    await fireEvent.keyDown(input, { key: "Escape" });
    await tick();
    await tick();

    expect(deleteFile).toHaveBeenCalledWith(OLD_PATH);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does NOT delete the file when Escape is pressed with isNewFile=false", async () => {
    const onCancel = vi.fn();
    const { container } = render(InlineRename, {
      props: { ...baseProps({ isNewFile: false }), onCancel },
    });

    const input = container.querySelector(".vc-rename-input") as HTMLInputElement;
    await fireEvent.keyDown(input, { key: "Escape" });
    await tick();

    expect(deleteFile).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("deletes the pending file when renameFile throws with isNewFile=true", async () => {
    (renameFile as any).mockRejectedValueOnce(new Error("boom"));

    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(InlineRename, {
      props: { ...baseProps({ isNewFile: true }), onConfirm, onCancel },
    });

    const input = container.querySelector(".vc-rename-input") as HTMLInputElement;
    input.value = "my-note.md";
    await fireEvent.input(input);
    await fireEvent.keyDown(input, { key: "Enter" });
    // Let the async renameFile rejection and cleanup settle.
    await tick();
    await tick();
    await tick();

    expect(renameFile).toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith(OLD_PATH);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does NOT delete the file when renameFile throws with isNewFile=false", async () => {
    (renameFile as any).mockRejectedValueOnce(new Error("boom"));

    const { container } = render(InlineRename, {
      props: baseProps({ isNewFile: false }),
    });

    const input = container.querySelector(".vc-rename-input") as HTMLInputElement;
    input.value = "renamed.md";
    await fireEvent.input(input);
    await fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    await tick();
    await tick();

    expect(renameFile).toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
