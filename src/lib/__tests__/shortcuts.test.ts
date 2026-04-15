/**
 * Tests for the central keyboard-shortcut registry (UI-05 / D-11).
 *
 * Covers:
 *   - Array shape and content
 *   - handleShortcut priority guards
 *   - formatShortcut display helper
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SHORTCUTS,
  handleShortcut,
  formatShortcut,
  type ShortcutContext,
  type ShortcutGuard,
} from "../shortcuts";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEvent(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
}

function makeCtx(overrides: Partial<ShortcutContext> = {}): ShortcutContext {
  return {
    openQuickSwitcher: vi.fn(),
    toggleSidebar: vi.fn(),
    openBacklinks: vi.fn(),
    activateSearchTab: vi.fn(),
    cycleTabNext: vi.fn(),
    cycleTabPrev: vi.fn(),
    closeActiveTab: vi.fn(),
    createNewNote: vi.fn(),
    openGraph: vi.fn(),
    toggleBookmark: vi.fn(),
    ...overrides,
  };
}

function makeGuard(overrides: Partial<ShortcutGuard> = {}): ShortcutGuard {
  return {
    settingsOpen: false,
    quickSwitcherOpen: false,
    inlineRenameActive: false,
    ...overrides,
  };
}

// ── Test 1: Array shape ───────────────────────────────────────────────────────

describe("SHORTCUTS array", () => {
  const EXPECTED_IDS = [
    "new-note",
    "quick-switcher",
    "search",
    "search-alt", // Cmd+F fallback
    "backlinks-toggle",
    "toggle-sidebar",
    "toggle-sidebar-alt", // BUG-05.1: Cmd+Shift+E alias for German keyboards
    "next-tab",
    "close-tab",
    "open-graph", // #32: Cmd/Ctrl+Shift+G — global graph tab
    "toggle-bookmark", // #12: Cmd/Ctrl+D — toggle bookmark on active note
  ];

  it("contains exactly 11 entries with the correct ids in order", () => {
    expect(SHORTCUTS).toHaveLength(11);
    const ids = SHORTCUTS.map((s) => s.id);
    expect(ids).toEqual(EXPECTED_IDS);
  });

  it("every entry has a non-empty German label and meta: true", () => {
    for (const s of SHORTCUTS) {
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.keys.meta).toBe(true);
    }
  });
});

// ── Test 3: handleShortcut fires handler for matching event ───────────────────

describe("handleShortcut", () => {
  it("fires new-note handler on Cmd+N (guards all false)", () => {
    const ctx = makeCtx();
    const guard = makeGuard();
    const e = makeEvent({ key: "n", metaKey: true });
    const fired = handleShortcut(e, ctx, guard);
    expect(fired).toBe(true);
    expect(ctx.createNewNote).toHaveBeenCalledOnce();
  });

  // Test 4: settingsOpen guard
  it("does NOT fire any handler when settingsOpen is true", () => {
    const ctx = makeCtx();
    const guard = makeGuard({ settingsOpen: true });
    const e = makeEvent({ key: "n", metaKey: true });
    const fired = handleShortcut(e, ctx, guard);
    expect(fired).toBe(false);
    expect(ctx.createNewNote).not.toHaveBeenCalled();
  });

  // Test 5: quickSwitcherOpen guard
  it("does NOT fire any handler when quickSwitcherOpen is true", () => {
    const ctx = makeCtx();
    const guard = makeGuard({ quickSwitcherOpen: true });
    const e = makeEvent({ key: "p", metaKey: true });
    const fired = handleShortcut(e, ctx, guard);
    expect(fired).toBe(false);
    expect(ctx.openQuickSwitcher).not.toHaveBeenCalled();
  });

  // Test 6: inlineRenameActive guard
  it("does NOT fire any handler when inlineRenameActive is true", () => {
    const ctx = makeCtx();
    const guard = makeGuard({ inlineRenameActive: true });
    const e = makeEvent({ key: "n", metaKey: true });
    const fired = handleShortcut(e, ctx, guard);
    expect(fired).toBe(false);
    expect(ctx.createNewNote).not.toHaveBeenCalled();
  });

  // Test 7: non-meta keystroke
  it("returns false without invoking anything for a non-meta keystroke", () => {
    const ctx = makeCtx();
    const guard = makeGuard();
    const e = makeEvent({ key: "n", metaKey: false, ctrlKey: false });
    const fired = handleShortcut(e, ctx, guard);
    expect(fired).toBe(false);
    expect(ctx.createNewNote).not.toHaveBeenCalled();
  });
});

// ── Test 8: formatShortcut display helper ─────────────────────────────────────

describe("formatShortcut", () => {
  it("returns Ctrl+Shift+F on non-Mac", () => {
    Object.defineProperty(navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
    const result = formatShortcut({ meta: true, shift: true, key: "F" });
    expect(result).toBe("Ctrl+Shift+F");
  });

  it("returns ⌘+Shift+F on Mac", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    const result = formatShortcut({ meta: true, shift: true, key: "F" });
    expect(result).toBe("⌘+Shift+F");
  });
});
