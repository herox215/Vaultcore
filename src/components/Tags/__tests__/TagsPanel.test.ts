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
    render(TagsPanel, { props: { onOpenContentSearch: () => {} } });
    expect(screen.getByText("Keine Tags")).toBeTruthy();
    expect(screen.getByText(/Erstelle Notizen mit #Tags/)).toBeTruthy();
  });

  it("renders tag rows with display name and count", async () => {
    (listTags as any).mockResolvedValueOnce([{ tag: "rust", count: 12 }]);
    render(TagsPanel, { props: { onOpenContentSearch: () => {} } });
    await tagsStore.reload(); await tick();
    expect(screen.getByText("#rust")).toBeTruthy();
    expect(screen.getByText("(12)")).toBeTruthy();
  });

  it("clicking a tag row dispatches to onOpenContentSearch with the prefixed query (TAG-04, #174)", async () => {
    // #174 — the sidebar no longer owns a search panel. Tag clicks dispatch to
    // VaultLayout which opens the omni-search modal in content mode; we verify
    // the dispatch shape (no store mutation any more).
    (listTags as any).mockResolvedValueOnce([{ tag: "rust", count: 12 }]);
    const onOpenContentSearch = vi.fn();
    render(TagsPanel, { props: { onOpenContentSearch } });
    await tagsStore.reload(); await tick();
    const btn = screen.getByText("#rust").closest("button") as HTMLButtonElement;
    await fireEvent.click(btn);
    expect(onOpenContentSearch).toHaveBeenCalledWith("#rust");
  });

  it("nested tags group under parent and expand on chevron click", async () => {
    (listTags as any).mockResolvedValueOnce([{ tag: "work/daily", count: 3 }, { tag: "work/weekly", count: 5 }]);
    render(TagsPanel, { props: { onOpenContentSearch: () => {} } });
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
