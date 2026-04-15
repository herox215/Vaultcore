import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import CommandPalette from "../CommandPalette.svelte";
import { commandRegistry } from "../../../lib/commands/registry";

function setupLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  });
}

type MockFn = ReturnType<typeof vi.fn> & ((...args: unknown[]) => unknown);

interface Calls {
  newNote: MockFn;
  search: MockFn;
  backlinks: MockFn;
  close: MockFn;
}

function registerFakes(calls: Calls) {
  commandRegistry.register({ id: "vault:new-note", name: "Neue Notiz", callback: () => calls.newNote(), hotkey: { meta: true, key: "n" } });
  commandRegistry.register({ id: "app:fulltext-search", name: "Volltext-Suche", callback: () => calls.search(), hotkey: { meta: true, shift: true, key: "f" } });
  commandRegistry.register({ id: "editor:toggle-backlinks", name: "Backlinks-Panel", callback: () => calls.backlinks(), hotkey: { meta: true, shift: true, key: "b" } });
  commandRegistry.register({ id: "tabs:close", name: "Tab schließen", callback: () => calls.close(), hotkey: { meta: true, key: "w" } });
}

describe("CommandPalette (#13)", () => {
  let calls: Calls;

  beforeEach(() => {
    setupLocalStorage();
    commandRegistry._reset();
    calls = {
      newNote: vi.fn() as MockFn,
      search: vi.fn() as MockFn,
      backlinks: vi.fn() as MockFn,
      close: vi.fn() as MockFn,
    };
    registerFakes(calls);
  });

  it("renders nothing when closed", () => {
    render(CommandPalette, { props: { open: false, onClose: () => {} } });
    expect(screen.queryByTestId("command-palette-input")).toBeNull();
  });

  it("renders input and all registered commands when opened", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {} } });
    await tick();
    expect(screen.getByTestId("command-palette-input")).toBeTruthy();
    const rows = screen.getAllByTestId("command-palette-row");
    expect(rows).toHaveLength(4);
    expect(screen.getByText("Neue Notiz")).toBeTruthy();
    expect(screen.getByText("Volltext-Suche")).toBeTruthy();
  });

  it("filters commands with fuzzy matching on the query", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {} } });
    await tick();
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Notiz" } });
    await tick();
    const rows = screen.getAllByTestId("command-palette-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-command-id")).toBe("vault:new-note");
  });

  it("Esc closes the palette", async () => {
    const onClose = vi.fn();
    render(CommandPalette, { props: { open: true, onClose } });
    await tick();
    const input = screen.getByTestId("command-palette-input");
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Enter closes the palette first, then executes the selected command", async () => {
    const onClose = vi.fn();
    render(CommandPalette, { props: { open: true, onClose } });
    await tick();
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Notiz" } });
    await tick();
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalledOnce();
    // Execute happens after tick().
    await tick();
    expect(calls.newNote).toHaveBeenCalledOnce();
  });

  it("ArrowDown/ArrowUp move the selected row", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {} } });
    await tick();
    const input = screen.getByTestId("command-palette-input");
    // By default first row is selected.
    let rows = screen.getAllByTestId("command-palette-row");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await tick();
    rows = screen.getAllByTestId("command-palette-row");
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
    await fireEvent.keyDown(input, { key: "ArrowUp" });
    await tick();
    rows = screen.getAllByTestId("command-palette-row");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a row closes then executes", async () => {
    const onClose = vi.fn();
    render(CommandPalette, { props: { open: true, onClose } });
    await tick();
    const rows = screen.getAllByTestId("command-palette-row");
    const target = rows.find((r) => r.getAttribute("data-command-id") === "tabs:close")!;
    await fireEvent.click(target);
    expect(onClose).toHaveBeenCalledOnce();
    await tick();
    expect(calls.close).toHaveBeenCalledOnce();
  });

  it("shows MRU items first when the query is empty", async () => {
    // Seed MRU: backlinks then search.
    commandRegistry.execute("editor:toggle-backlinks");
    commandRegistry.execute("app:fulltext-search");
    render(CommandPalette, { props: { open: true, onClose: () => {} } });
    await tick();
    const rows = screen.getAllByTestId("command-palette-row");
    expect(rows[0]!.getAttribute("data-command-id")).toBe("app:fulltext-search");
    expect(rows[1]!.getAttribute("data-command-id")).toBe("editor:toggle-backlinks");
  });

  it("shows a bound hotkey for each command", async () => {
    render(CommandPalette, { props: { open: true, onClose: () => {} } });
    await tick();
    // There should be at least one <kbd> visible.
    const kbds = document.querySelectorAll(".vc-cp-row-hotkey kbd");
    expect(kbds.length).toBeGreaterThan(0);
  });
});
