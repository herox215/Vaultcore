import { describe, it, expect, beforeEach, vi } from "vitest";
import { commandRegistry } from "../registry";
import {
  CMD_IDS,
  DEFAULT_COMMAND_SPECS,
  registerDefaultCommands,
  type DefaultCommandContext,
} from "../defaultCommands";

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

function makeCtx(overrides: Partial<DefaultCommandContext> = {}): DefaultCommandContext {
  const noop = () => {};
  return {
    openQuickSwitcher: noop,
    toggleSidebar: noop,
    openBacklinks: noop,
    activateSearchTab: noop,
    cycleTabNext: noop,
    cycleTabPrev: noop,
    closeActiveTab: noop,
    createNewNote: noop,
    openGraph: noop,
    openCommandPalette: noop,
    toggleBookmark: noop,
    openTodayNote: noop,
    ...overrides,
  };
}

describe("defaultCommands — vault:open-today (#59)", () => {
  beforeEach(() => {
    setupLocalStorage();
    commandRegistry._reset();
  });

  it("registers vault:open-today with a palette label and Cmd+Shift+D hotkey", () => {
    const spec = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.OPEN_TODAY);
    expect(spec).toBeTruthy();
    expect(spec!.name.length).toBeGreaterThan(0);
    expect(spec!.hotkey).toEqual({ meta: true, shift: true, key: "d" });
  });

  it("registerDefaultCommands wires openTodayNote callback and exposes it via execute()", () => {
    const openTodayNote = vi.fn();
    registerDefaultCommands(makeCtx({ openTodayNote }));
    const cmd = commandRegistry.list().find((c) => c.id === CMD_IDS.OPEN_TODAY);
    expect(cmd).toBeTruthy();
    commandRegistry.execute(CMD_IDS.OPEN_TODAY);
    expect(openTodayNote).toHaveBeenCalledOnce();
  });

  it("Cmd+Shift+D resolves to vault:open-today via findByHotkey", () => {
    registerDefaultCommands(makeCtx());
    const ev = new KeyboardEvent("keydown", { key: "d", metaKey: true, shiftKey: true });
    expect(commandRegistry.findByHotkey(ev)?.id).toBe(CMD_IDS.OPEN_TODAY);
    // Plain Cmd+D still resolves to the bookmark command — no collision.
    const plainEv = new KeyboardEvent("keydown", { key: "d", metaKey: true });
    expect(commandRegistry.findByHotkey(plainEv)?.id).toBe(CMD_IDS.TOGGLE_BOOKMARK);
  });
});
