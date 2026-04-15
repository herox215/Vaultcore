// Default commands migrated from the old hardcoded shortcut list (#13).
// Stable ids are namespaced so future additions don't collide.

import { commandRegistry, type Command, type HotKey } from "./registry";

export interface DefaultCommandContext {
  openQuickSwitcher: () => void;
  toggleSidebar: () => void;
  openBacklinks: () => void;
  activateSearchTab: () => void;
  cycleTabNext: () => void;
  cycleTabPrev: () => void;
  closeActiveTab: () => void;
  createNewNote: () => void;
  openGraph: () => void;
  openCommandPalette: () => void;
  toggleBookmark: () => void;
}

/** Id constants — consumed by tests and anyone dispatching by id. */
export const CMD_IDS = {
  NEW_NOTE: "vault:new-note",
  QUICK_SWITCHER: "app:quick-switcher",
  SEARCH: "app:fulltext-search",
  SEARCH_ALT: "app:fulltext-search-alt",
  BACKLINKS_TOGGLE: "editor:toggle-backlinks",
  TOGGLE_SIDEBAR: "app:toggle-sidebar",
  TOGGLE_SIDEBAR_ALT: "app:toggle-sidebar-alt",
  NEXT_TAB: "tabs:next",
  CLOSE_TAB: "tabs:close",
  OPEN_GRAPH: "vault:open-graph",
  COMMAND_PALETTE: "app:command-palette",
  TOGGLE_BOOKMARK: "vault:toggle-bookmark",
} as const;

export interface DefaultCommandSpec {
  id: string;
  name: string;
  hotkey?: HotKey;
}

/** Static metadata — id, label, hotkey. Callback is wired in registerDefaultCommands. */
export const DEFAULT_COMMAND_SPECS: readonly DefaultCommandSpec[] = [
  { id: CMD_IDS.NEW_NOTE, name: "Neue Notiz", hotkey: { meta: true, key: "n" } },
  { id: CMD_IDS.QUICK_SWITCHER, name: "Schnellwechsler", hotkey: { meta: true, key: "o" } },
  { id: CMD_IDS.SEARCH, name: "Volltext-Suche", hotkey: { meta: true, shift: true, key: "f" } },
  { id: CMD_IDS.SEARCH_ALT, name: "Volltext-Suche (Alternative)", hotkey: { meta: true, key: "f" } },
  { id: CMD_IDS.BACKLINKS_TOGGLE, name: "Backlinks-Panel", hotkey: { meta: true, shift: true, key: "b" } },
  { id: CMD_IDS.TOGGLE_SIDEBAR, name: "Seitenleiste ein-/ausblenden", hotkey: { meta: true, key: "\\" } },
  { id: CMD_IDS.TOGGLE_SIDEBAR_ALT, name: "Seitenleiste ein-/ausblenden (Alternative)", hotkey: { meta: true, shift: true, key: "e" } },
  { id: CMD_IDS.NEXT_TAB, name: "Nächster Tab", hotkey: { meta: true, key: "Tab" } },
  { id: CMD_IDS.CLOSE_TAB, name: "Tab schließen", hotkey: { meta: true, key: "w" } },
  { id: CMD_IDS.OPEN_GRAPH, name: "Graph-Ansicht öffnen", hotkey: { meta: true, shift: true, key: "g" } },
  { id: CMD_IDS.COMMAND_PALETTE, name: "Befehlspalette", hotkey: { meta: true, key: "p" } },
  { id: CMD_IDS.TOGGLE_BOOKMARK, name: "Lesezeichen umschalten", hotkey: { meta: true, key: "d" } },
] as const;

/**
 * Register every default command against the live registry using the given
 * context's callbacks. Call once during app mount; any subsequent call
 * re-registers (idempotent).
 */
export function registerDefaultCommands(ctx: DefaultCommandContext): void {
  const byId: Record<string, () => void> = {
    [CMD_IDS.NEW_NOTE]: ctx.createNewNote,
    [CMD_IDS.QUICK_SWITCHER]: ctx.openQuickSwitcher,
    [CMD_IDS.SEARCH]: ctx.activateSearchTab,
    [CMD_IDS.SEARCH_ALT]: ctx.activateSearchTab,
    [CMD_IDS.BACKLINKS_TOGGLE]: ctx.openBacklinks,
    [CMD_IDS.TOGGLE_SIDEBAR]: ctx.toggleSidebar,
    [CMD_IDS.TOGGLE_SIDEBAR_ALT]: ctx.toggleSidebar,
    [CMD_IDS.NEXT_TAB]: ctx.cycleTabNext,
    [CMD_IDS.CLOSE_TAB]: ctx.closeActiveTab,
    [CMD_IDS.OPEN_GRAPH]: ctx.openGraph,
    [CMD_IDS.COMMAND_PALETTE]: ctx.openCommandPalette,
    [CMD_IDS.TOGGLE_BOOKMARK]: ctx.toggleBookmark,
  };

  for (const spec of DEFAULT_COMMAND_SPECS) {
    const cb = byId[spec.id];
    if (!cb) continue;
    const cmd: Command = {
      id: spec.id,
      name: spec.name,
      callback: cb,
      ...(spec.hotkey ? { hotkey: spec.hotkey } : {}),
    };
    commandRegistry.register(cmd);
  }
}
