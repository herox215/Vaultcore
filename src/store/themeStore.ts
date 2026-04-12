/**
 * themeStore — runtime dark/light/auto switching (UI-01, D-05/D-07).
 *
 * Writes `document.documentElement.dataset.theme` and persists to
 * `localStorage['vaultcore-theme']`. Whitelist guard (T-05-02-01) rejects
 * any non-whitelisted value — this prevents CSS injection via tampered
 * localStorage.
 *
 * Pattern: classic writable factory (D-06/RC-01 locked). Do not refactor
 * to Svelte 5 $state runes.
 */
import { writable } from "svelte/store";

export type Theme = "light" | "dark" | "auto";
const VALID_THEMES: readonly Theme[] = ["light", "dark", "auto"] as const;
const STORAGE_KEY = "vaultcore-theme";
const DEFAULT_THEME: Theme = "auto";

function isValidTheme(v: unknown): v is Theme {
  return typeof v === "string" && (VALID_THEMES as readonly string[]).includes(v);
}

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isValidTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function createThemeStore() {
  const _store = writable<Theme>(DEFAULT_THEME);
  return {
    subscribe: _store.subscribe,
    /** Apply stored theme to DOM. Call once on app start before first paint. */
    init(): void {
      const t = readStored();
      _store.set(t);
      document.documentElement.dataset.theme = t;
    },
    /** Change theme at runtime. Invalid values are rejected silently. */
    set(theme: Theme): void {
      if (!isValidTheme(theme)) return;
      _store.set(theme);
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
    },
  };
}

export const themeStore = createThemeStore();
