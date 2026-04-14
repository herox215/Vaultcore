import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { render, screen, fireEvent } from "@testing-library/svelte";
import Breadcrumbs from "../src/components/Editor/Breadcrumbs.svelte";
import { vaultStore } from "../src/store/vaultStore";
import { treeRevealStore } from "../src/store/treeRevealStore";

describe("Breadcrumbs (issue #8)", () => {
  beforeEach(() => {
    vaultStore.reset();
    treeRevealStore.clearPending();
    vaultStore.setReady({
      currentPath: "/vault",
      fileList: [],
      fileCount: 0,
    });
  });

  it("renders nothing when filePath is null", () => {
    const { container } = render(Breadcrumbs, { filePath: null });
    expect(container.querySelector(".vc-breadcrumbs")).toBeNull();
  });

  it("renders nothing when the path is outside the vault", () => {
    const { container } = render(Breadcrumbs, {
      filePath: "/other/somewhere.md",
    });
    expect(container.querySelector(".vc-breadcrumbs")).toBeNull();
  });

  it("renders one segment per path component for a nested file", () => {
    render(Breadcrumbs, {
      filePath: "/vault/Projects/Work/Vaultcore/notes/ideas.md",
    });
    const segments = screen.getAllByText(
      (_, el) => !!el && el.classList.contains("vc-breadcrumbs-segment"),
    );
    const labels = segments.map((s) => s.textContent?.trim());
    expect(labels).toEqual([
      "Projects",
      "Work",
      "Vaultcore",
      "notes",
      "ideas.md",
    ]);
  });

  it("styles the filename segment distinctly (file modifier class)", () => {
    render(Breadcrumbs, { filePath: "/vault/notes/ideas.md" });
    const file = screen.getByText("ideas.md");
    expect(file.classList.contains("vc-breadcrumbs-segment--file")).toBe(true);
    expect(file.tagName.toLowerCase()).toBe("span");
  });

  it("renders folder segments as buttons (filename is not a button)", () => {
    render(Breadcrumbs, { filePath: "/vault/a/b/c.md" });
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["a", "b"]);
  });

  it("clicking a folder segment requests a reveal for that folder path", async () => {
    render(Breadcrumbs, {
      filePath: "/vault/Projects/Work/Vaultcore/notes/ideas.md",
    });
    const workButton = screen.getByRole("button", { name: /Work/ });
    await fireEvent.click(workButton);
    const state = get(treeRevealStore);
    expect(state.pending?.relPath).toBe("Projects/Work");
  });

  it("clicking the filename is a no-op (does not issue a reveal request)", async () => {
    render(Breadcrumbs, { filePath: "/vault/notes/ideas.md" });
    const tokenBefore = get(treeRevealStore).pending?.token ?? null;
    const file = screen.getByText("ideas.md");
    await fireEvent.click(file);
    expect(get(treeRevealStore).pending?.token ?? null).toBe(tokenBefore);
  });

  it("uses the › separator between segments", () => {
    const { container } = render(Breadcrumbs, {
      filePath: "/vault/a/b/c.md",
    });
    const seps = container.querySelectorAll(".vc-breadcrumbs-sep");
    expect(seps.length).toBe(2);
    expect(seps[0]?.textContent).toBe("\u203A");
  });
});
