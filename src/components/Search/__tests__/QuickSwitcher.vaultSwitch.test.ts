import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({ searchFilename: vi.fn() }));
import { searchFilename } from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { tabStore } from "../../../store/tabStore";
import QuickSwitcher from "../QuickSwitcher.svelte";

describe("QuickSwitcher clears stale filename results on vault switch (#46)", () => {
  beforeEach(() => {
    vaultStore.reset();
    tabStore.closeAll();
    vi.clearAllMocks();
  });

  it("resets query and results when currentPath changes from A to B", async () => {
    // Open Vault A
    vaultStore.setReady({ currentPath: "/tmp/vault-a", fileList: [], fileCount: 0 });

    const onClose = vi.fn();
    const onOpenFile = vi.fn();
    const { container } = render(QuickSwitcher, {
      props: { open: true, onClose, onOpenFile },
    });
    await tick();

    // Type a query — filename IPC returns a Vault-A hit.
    (searchFilename as any).mockResolvedValueOnce([
      { path: "notes/alpha.md", score: 100, matchIndices: [] },
    ]);
    const input = container.querySelector("input.vc-qs-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "alpha" } });
    await tick();
    await Promise.resolve();
    await tick();

    expect(input.value).toBe("alpha");
    // Result row from Vault A should be rendered.
    expect(container.querySelector(".vc-qs-results")?.textContent ?? "").toContain("alpha.md");

    // Switch to Vault B — modal stays open (simulates the race condition
    // described in the ticket: user opens QuickSwitcher, runs search in A,
    // something else triggers a vault switch).
    vaultStore.setReady({ currentPath: "/tmp/vault-b", fileList: [], fileCount: 0 });
    await tick();

    // Query and result list should both be cleared.
    expect(input.value).toBe("");
    const resultsText = container.querySelector(".vc-qs-results")?.textContent ?? "";
    expect(resultsText).not.toContain("alpha.md");
  });
});
