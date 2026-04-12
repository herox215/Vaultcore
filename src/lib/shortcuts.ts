/**
 * Central keyboard-shortcut registry (UI-05 / D-11).
 *
 * Every Phase 5+ MVP shortcut from spec Section 13 is declared here so
 * VaultLayout.handleKeydown and SettingsModal's Tastaturkürzel table read
 * from the same source.
 *
 * Priority (UI-SPEC Interaction Contracts):
 *   1. settingsOpen     → modal handles its own events (caller short-circuits)
 *   2. quickSwitcherOpen → switcher handles ArrowUp/Down/Enter/Escape
 *   3. inlineRenameActive → no global shortcuts fire
 *   4. otherwise → iterate SHORTCUTS, first match wins
 */

export interface ShortcutKeys {
  /** True if Cmd (Mac) OR Ctrl (other) — we treat them equivalently. */
  meta: boolean;
  shift?: boolean;
  /** Case-insensitive; compared via toLowerCase of event.key. */
  key: string;
}

export interface ShortcutContext {
  openQuickSwitcher: () => void;
  toggleSidebar: () => void;
  openBacklinks: () => void;
  activateSearchTab: () => void;
  cycleTabNext: () => void;
  cycleTabPrev: () => void;
  closeActiveTab: () => void;
  createNewNote: () => void;
}

export interface Shortcut {
  id: string;
  keys: ShortcutKeys;
  label: string; // German, rendered in SettingsModal Section C
  handler: (ctx: ShortcutContext, event: KeyboardEvent) => void;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "new-note",
    keys: { meta: true, key: "n" },
    label: "Neue Notiz",
    handler: (ctx) => { ctx.createNewNote(); },
  },
  {
    id: "quick-switcher",
    keys: { meta: true, key: "p" },
    label: "Schnellwechsler",
    handler: (ctx) => { ctx.openQuickSwitcher(); },
  },
  {
    id: "search",
    keys: { meta: true, shift: true, key: "f" },
    label: "Volltext-Suche",
    handler: (ctx) => { ctx.activateSearchTab(); },
  },
  {
    id: "backlinks-toggle",
    keys: { meta: true, shift: true, key: "b" },
    label: "Backlinks-Panel",
    handler: (ctx) => { ctx.openBacklinks(); },
  },
  {
    id: "toggle-sidebar",
    keys: { meta: true, key: "\\" },
    label: "Seitenleiste ein-/ausblenden",
    handler: (ctx) => { ctx.toggleSidebar(); },
  },
  {
    id: "next-tab",
    keys: { meta: true, key: "Tab" },
    label: "Nächster Tab",
    handler: (ctx, e) => {
      if (e.shiftKey) ctx.cycleTabPrev();
      else ctx.cycleTabNext();
    },
  },
  {
    id: "close-tab",
    keys: { meta: true, key: "w" },
    label: "Tab schließen",
    handler: (ctx) => { ctx.closeActiveTab(); },
  },
] as const;

export interface ShortcutGuard {
  settingsOpen: boolean;
  quickSwitcherOpen: boolean;
  inlineRenameActive: boolean;
}

/**
 * Match `event` against every SHORTCUTS entry and invoke the first matching handler.
 * Returns true if a handler fired. Caller uses the boolean to decide preventDefault.
 *
 * Priority guards:
 *   1. settingsOpen or inlineRenameActive → always false
 *   2. quickSwitcherOpen → always false (switcher handles its own keys)
 *   3. no meta/ctrl → false
 *   4. Iterate SHORTCUTS — first match wins
 */
export function handleShortcut(
  event: KeyboardEvent,
  ctx: ShortcutContext,
  guard: ShortcutGuard,
): boolean {
  if (guard.settingsOpen || guard.inlineRenameActive) return false;
  const isMeta = event.metaKey || event.ctrlKey;
  if (!isMeta) return false;
  if (guard.quickSwitcherOpen) return false;

  const keyLower = event.key.toLowerCase();
  for (const s of SHORTCUTS) {
    // For entries with shift: true we require shiftKey to match.
    // The next-tab entry uses shift to pick direction — don't exclude on shift mismatch.
    const shiftOk =
      s.id === "next-tab"
        ? true // Shift toggles direction, not a distinct binding
        : s.keys.shift === true
          ? event.shiftKey
          : !event.shiftKey; // non-shift bindings must NOT have shiftKey held (prevents Cmd+Shift+N matching Cmd+N)

    if (s.keys.meta === isMeta && s.keys.key.toLowerCase() === keyLower && shiftOk) {
      event.preventDefault();
      s.handler(ctx, event);
      return true;
    }
  }
  return false;
}

/**
 * Pretty-print a ShortcutKeys object for the Settings modal shortcut table.
 * Mac: ⌘+Shift+F. Other: Ctrl+Shift+F.
 */
export function formatShortcut(keys: ShortcutKeys): string {
  const isMac =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const metaSymbol = isMac ? "⌘" : "Ctrl";
  const parts: string[] = [];
  if (keys.meta) parts.push(metaSymbol);
  if (keys.shift) parts.push("Shift");
  // Special display names
  const keyLabel =
    keys.key === "\\"
      ? "\\"
      : keys.key === "Tab"
        ? "Tab"
        : keys.key.toUpperCase();
  parts.push(keyLabel);
  return parts.join("+");
}
