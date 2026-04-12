import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({ listTags: vi.fn() }));
import { listTags } from "../../../ipc/commands";
import { tagsStore } from "../../../store/tagsStore";
import { searchStore } from "../../../store/searchStore";
import TagsPanel from "../TagsPanel.svelte";

describe("TagsPanel (TAG-03/TAG-04)", () => {
  beforeEach(() => { tagsStore.reset(); searchStore.reset(); vi.clearAllMocks(); });

  it("renders Keine Tags empty state when tags are empty", () => {
    render(TagsPanel);
    expect(screen.getByText("Keine Tags")).toBeTruthy();
    expect(screen.getByText(/Erstelle Notizen mit #Tags/)).toBeTruthy();
  });

  it("renders tag rows with display name and count", async () => {
    (listTags as any).mockResolvedValueOnce([{ tag: "rust", count: 12 }]);
    render(TagsPanel);
    await tagsStore.reload(); await tick();
    expect(screen.getByText("#rust")).toBeTruthy();
    expect(screen.getByText("(12)")).toBeTruthy();
  });

  it("clicking a tag row switches to search tab and prefills query (TAG-04)", async () => {
    (listTags as any).mockResolvedValueOnce([{ tag: "rust", count: 12 }]);
    render(TagsPanel);
    await tagsStore.reload(); await tick();
    const btn = screen.getByText("#rust").closest("button") as HTMLButtonElement;
    await fireEvent.click(btn);
    const { get } = await import("svelte/store");
    expect(get(searchStore).activeTab).toBe("search");
    expect(get(searchStore).query).toBe("#rust");
  });

  it("nested tags group under parent and expand on chevron click", async () => {
    (listTags as any).mockResolvedValueOnce([{ tag: "work/daily", count: 3 }, { tag: "work/weekly", count: 5 }]);
    render(TagsPanel);
    await tagsStore.reload(); await tick();
    // Parent 'work' renders
    expect(screen.getByText("#work")).toBeTruthy();
    // Children hidden initially
    expect(screen.queryByText("#daily")).toBeNull();
    // Click chevron
    const chevron = screen.getByLabelText("Ausklappen");
    await fireEvent.click(chevron);
    await tick();
    expect(screen.getByText("#daily")).toBeTruthy();
    expect(screen.getByText("#weekly")).toBeTruthy();
  });
});
