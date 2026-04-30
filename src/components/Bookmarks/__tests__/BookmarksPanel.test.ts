import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  loadBookmarks: vi.fn(),
  saveBookmarks: vi.fn(),
}));

import { loadBookmarks, saveBookmarks } from "../../../ipc/commands";
import { bookmarksStore } from "../../../store/bookmarksStore";
import { vaultStore } from "../../../store/vaultStore";
import { tabStore } from "../../../store/tabStore";
import BookmarksPanel from "../BookmarksPanel.svelte";

const VAULT = "/tmp/test-vault";

describe("BookmarksPanel (#12)", () => {
  beforeEach(() => {
    bookmarksStore.reset();
    vaultStore.reset();
    tabStore._reset();
    vi.clearAllMocks();
    (saveBookmarks as any).mockResolvedValue(undefined);
    (loadBookmarks as any).mockResolvedValue([]);
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it("renders empty state when no bookmarks", () => {
    render(BookmarksPanel);
    expect(screen.getByText("Keine Lesezeichen")).toBeTruthy();
  });

  it("renders rows sourced from bookmarksStore.paths", async () => {
    vaultStore.setReady({ currentPath: VAULT, fileList: ["a.md", "b.md"], fileCount: 2 });
    await bookmarksStore.toggle("a.md", VAULT);
    await bookmarksStore.toggle("b.md", VAULT);
    render(BookmarksPanel);
    await tick();
    expect(screen.getByText("a.md")).toBeTruthy();
    expect(screen.getByText("b.md")).toBeTruthy();
  });

  it("clicking a row calls tabStore.openTab with absolute path", async () => {
    vaultStore.setReady({ currentPath: VAULT, fileList: ["notes/a.md"], fileCount: 1 });
    await bookmarksStore.toggle("notes/a.md", VAULT);
    const spy = vi.spyOn(tabStore, "openTab");
    render(BookmarksPanel);
    await tick();
    const label = screen.getByText("a.md");
    await fireEvent.click(label);
    // #388 — clicks now route through openFileAsTab, which passes the
    // viewport-aware viewMode hint to tabStore.openTab. In jsdom (no
    // matchMedia overrides) the viewport reports desktop, so the hint
    // resolves to "edit". Assert the absolute path explicitly via the
    // first call argument; the second arg is the viewMode hint.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toBe(`${VAULT}/notes/a.md`);
    expect(spy.mock.calls[0]?.[1]).toBe("edit");
  });

  it("renders a broken bookmark dimmed and shows a remove button", async () => {
    vaultStore.setReady({ currentPath: VAULT, fileList: ["real.md"], fileCount: 1 });
    await bookmarksStore.toggle("missing.md", VAULT);
    const { container } = render(BookmarksPanel);
    await tick();
    const brokenRow = container.querySelector(".vc-bookmark-row--broken");
    expect(brokenRow).toBeTruthy();
    const removeBtn = brokenRow?.querySelector(".vc-bookmark-remove");
    expect(removeBtn).toBeTruthy();
  });

  it("remove button on broken row removes the bookmark and persists", async () => {
    vaultStore.setReady({ currentPath: VAULT, fileList: ["real.md"], fileCount: 1 });
    await bookmarksStore.toggle("missing.md", VAULT);
    vi.clearAllMocks();
    (saveBookmarks as any).mockResolvedValue(undefined);
    const { container } = render(BookmarksPanel);
    await tick();
    const removeBtn = container.querySelector(".vc-bookmark-row--broken .vc-bookmark-remove") as HTMLButtonElement;
    await fireEvent.click(removeBtn);
    await tick();
    expect(saveBookmarks).toHaveBeenCalledWith(VAULT, []);
  });

  it("drag-and-drop reorder updates the store via reorder()", async () => {
    vaultStore.setReady({ currentPath: VAULT, fileList: ["a.md", "b.md", "c.md"], fileCount: 3 });
    await bookmarksStore.toggle("a.md", VAULT);
    await bookmarksStore.toggle("b.md", VAULT);
    await bookmarksStore.toggle("c.md", VAULT);
    vi.clearAllMocks();
    (saveBookmarks as any).mockResolvedValue(undefined);

    const { container } = render(BookmarksPanel);
    await tick();
    const rows = Array.from(container.querySelectorAll<HTMLLIElement>(".vc-bookmark-row"));
    expect(rows).toHaveLength(3);
    const row0 = rows[0]!;
    const row2 = rows[2]!;

    // Simulate drag from index 0 (a.md) to index 2 (drop before c.md).
    const dataTransfer = {
      _data: new Map<string, string>(),
      types: ["text/vaultcore-bookmark"] as string[],
      setData(key: string, val: string) { this._data.set(key, val); this.types = Array.from(this._data.keys()); },
      getData(key: string) { return this._data.get(key) ?? ""; },
      effectAllowed: "move",
    };
    await fireEvent.dragStart(row0, { dataTransfer });
    await fireEvent.dragOver(row2, { dataTransfer });
    await fireEvent.drop(row2, { dataTransfer });
    await tick();

    // From 0 to 2 => insertAt = 2 - 1 = 1 after splice; order becomes [b, a, c].
    expect(saveBookmarks).toHaveBeenCalled();
    const lastCall = (saveBookmarks as any).mock.calls[(saveBookmarks as any).mock.calls.length - 1];
    expect(lastCall[0]).toBe(VAULT);
    expect(lastCall[1]).toEqual(["b.md", "a.md", "c.md"]);
  });

  it("collapsing hides the list", async () => {
    vaultStore.setReady({ currentPath: VAULT, fileList: ["a.md"], fileCount: 1 });
    await bookmarksStore.toggle("a.md", VAULT);
    const { container } = render(BookmarksPanel);
    await tick();
    expect(container.querySelector("[data-testid='vc-bookmarks-list']")).toBeTruthy();
    const header = screen.getByRole("button", { name: /Bookmarks/i });
    await fireEvent.click(header);
    await tick();
    expect(container.querySelector("[data-testid='vc-bookmarks-list']")).toBeNull();
  });
});
