/**
 * Tests for the shortcut display helper (#13 thin compat layer).
 * The per-command array and dispatch logic now live in commands/registry.ts
 * and commands/defaultCommands.ts.
 */
import { describe, it, expect } from "vitest";
import { formatShortcut } from "../shortcuts";

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

  it("renders Tab and backslash keys verbatim", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    expect(formatShortcut({ meta: true, key: "Tab" })).toBe("⌘+Tab");
    expect(formatShortcut({ meta: true, key: "\\" })).toBe("⌘+\\");
  });
});
