// Thin compat layer over the command registry (#13).
//
// Historical callers imported `ShortcutKeys` and `formatShortcut` from here.
// Both still live here so the Settings table and any external references
// keep working. The per-shortcut array and the `handleShortcut` dispatcher
// have moved to src/lib/commands/registry.ts and defaultCommands.ts.

export type { HotKey as ShortcutKeys } from "./commands/registry";

/**
 * Pretty-print a hotkey for display (e.g. Settings modal).
 * Mac: ⌘+Shift+F. Other: Ctrl+Shift+F.
 */
export function formatShortcut(keys: {
  meta: boolean;
  shift?: boolean;
  key: string;
}): string {
  const isMac =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const metaSymbol = isMac ? "⌘" : "Ctrl";
  const parts: string[] = [];
  if (keys.meta) parts.push(metaSymbol);
  if (keys.shift) parts.push("Shift");
  const keyLabel =
    keys.key === "\\" ? "\\" : keys.key === "Tab" ? "Tab" : keys.key.toUpperCase();
  parts.push(keyLabel);
  return parts.join("+");
}
