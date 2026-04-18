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
    createNewCanvas: noop,
    createNewFolder: noop,
    openGraph: noop,
    openCommandPalette: noop,
    toggleBookmark: noop,
    openTodayNote: noop,
    exportActiveNoteHtml: noop,
    exportActiveNotePdf: noop,
    toggleReadingMode: noop,
    insertTemplate: noop,
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

describe("defaultCommands — vault:export-html / vault:export-pdf (#61)", () => {
  beforeEach(() => {
    setupLocalStorage();
    commandRegistry._reset();
  });

  it("registers export-html without a default hotkey", () => {
    const spec = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.EXPORT_HTML);
    expect(spec).toBeTruthy();
    expect(spec!.hotkey).toBeUndefined();
    expect(spec!.name.length).toBeGreaterThan(0);
  });

  it("registers export-pdf without a default hotkey", () => {
    const spec = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.EXPORT_PDF);
    expect(spec).toBeTruthy();
    expect(spec!.hotkey).toBeUndefined();
  });

  it("execute wires the exportActiveNoteHtml / exportActiveNotePdf callbacks", () => {
    const exportHtml = vi.fn();
    const exportPdf = vi.fn();
    registerDefaultCommands(
      makeCtx({ exportActiveNoteHtml: exportHtml, exportActiveNotePdf: exportPdf }),
    );
    commandRegistry.execute(CMD_IDS.EXPORT_HTML);
    commandRegistry.execute(CMD_IDS.EXPORT_PDF);
    expect(exportHtml).toHaveBeenCalledOnce();
    expect(exportPdf).toHaveBeenCalledOnce();
  });
});

describe("defaultCommands — file creation (#145)", () => {
  beforeEach(() => {
    setupLocalStorage();
    commandRegistry._reset();
  });

  it("registers new-note / new-canvas / new-folder with English palette labels", () => {
    const note = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.NEW_NOTE);
    const canvas = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.NEW_CANVAS);
    const folder = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.NEW_FOLDER);
    expect(note?.name).toBe("File: New note");
    expect(canvas?.name).toBe("File: New canvas");
    expect(folder?.name).toBe("File: New folder");
  });

  it("binds Cmd+Shift+C to new-canvas without clashing with plain Cmd+C", () => {
    registerDefaultCommands(makeCtx());
    const shiftEv = new KeyboardEvent("keydown", { key: "c", metaKey: true, shiftKey: true });
    expect(commandRegistry.findByHotkey(shiftEv)?.id).toBe(CMD_IDS.NEW_CANVAS);
    const plainEv = new KeyboardEvent("keydown", { key: "c", metaKey: true });
    // Plain Cmd+C is editor copy — no default command owns it.
    expect(commandRegistry.findByHotkey(plainEv)).toBeNull();
  });

  it("new-folder has no default hotkey (palette-only entry)", () => {
    const folder = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.NEW_FOLDER);
    expect(folder?.hotkey).toBeUndefined();
  });

  it("registerDefaultCommands wires all three create callbacks", () => {
    const createNewNote = vi.fn();
    const createNewCanvas = vi.fn();
    const createNewFolder = vi.fn();
    registerDefaultCommands(makeCtx({ createNewNote, createNewCanvas, createNewFolder }));
    commandRegistry.execute(CMD_IDS.NEW_NOTE);
    commandRegistry.execute(CMD_IDS.NEW_CANVAS);
    commandRegistry.execute(CMD_IDS.NEW_FOLDER);
    expect(createNewNote).toHaveBeenCalledOnce();
    expect(createNewCanvas).toHaveBeenCalledOnce();
    expect(createNewFolder).toHaveBeenCalledOnce();
  });
});

describe("defaultCommands — editor:toggle-reading-mode (#63)", () => {
  beforeEach(() => {
    setupLocalStorage();
    commandRegistry._reset();
  });

  it("registers editor:toggle-reading-mode with a label and Cmd+E hotkey", () => {
    const spec = DEFAULT_COMMAND_SPECS.find((s) => s.id === CMD_IDS.TOGGLE_READING_MODE);
    expect(spec).toBeTruthy();
    expect(spec!.name.length).toBeGreaterThan(0);
    expect(spec!.hotkey).toEqual({ meta: true, key: "e" });
    // Cmd+Shift+E is already claimed by TOGGLE_SIDEBAR_ALT; make sure the
    // reading-mode binding is plain Cmd+E so the two don't collide.
    expect(spec!.hotkey!.shift ?? false).toBe(false);
  });

  it("registerDefaultCommands wires toggleReadingMode callback", () => {
    const toggleReadingMode = vi.fn();
    registerDefaultCommands(makeCtx({ toggleReadingMode }));
    commandRegistry.execute(CMD_IDS.TOGGLE_READING_MODE);
    expect(toggleReadingMode).toHaveBeenCalledOnce();
  });

  it("Cmd+E resolves to editor:toggle-reading-mode via findByHotkey", () => {
    registerDefaultCommands(makeCtx());
    const ev = new KeyboardEvent("keydown", { key: "e", metaKey: true });
    expect(commandRegistry.findByHotkey(ev)?.id).toBe(CMD_IDS.TOGGLE_READING_MODE);
    // Cmd+Shift+E still resolves to the sidebar-toggle alt — no collision.
    const shiftEv = new KeyboardEvent("keydown", { key: "e", metaKey: true, shiftKey: true });
    expect(commandRegistry.findByHotkey(shiftEv)?.id).toBe(CMD_IDS.TOGGLE_SIDEBAR_ALT);
  });
});
