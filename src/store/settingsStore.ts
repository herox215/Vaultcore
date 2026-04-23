/**
 * settingsStore — body/mono font family + editor font size (UI-02, D-08/D-09)
 * plus Daily Notes folder / date format / template (#59).
 *
 * Whitelist for font keys (T-05-02-02) maps safe tokens to full CSS stacks so
 * a tampered localStorage cannot inject `expression(...)` or `"; } body{…` into
 * the --vc-font-* custom properties.
 *
 * Daily-notes strings are user-supplied but only ever handed to the IPC layer
 * (which canonicalizes paths against the vault root) or the filename builder
 * (which whitelists YYYY/MM/DD tokens). validate-on-read still caps length
 * and strips non-strings so a tampered entry can't grow unbounded.
 *
 * Pattern: classic writable factory (D-06/RC-01 locked). Do not refactor
 * to Svelte 5 $state runes.
 */
import { writable } from "svelte/store";
import { DEFAULT_DAILY_DATE_FORMAT } from "../lib/dailyNotes";

export type BodyFont = "system" | "inter" | "lora";
export type MonoFont = "system" | "jetbrains-mono" | "fira-code";

const BODY_STACKS: Record<BodyFont, string> = {
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  inter:  '"Inter", system-ui, sans-serif',
  lora:   '"Lora", Georgia, serif',
};
const MONO_STACKS: Record<MonoFont, string> = {
  system:           '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
  "jetbrains-mono": '"JetBrains Mono", monospace',
  "fira-code":      '"Fira Code", monospace',
};

/**
 * Lazy font loaders — issue #255. Previously `src/main.ts` statically
 * imported 8 `@fontsource/*` CSS files before Svelte mounted, forcing the
 * browser to fetch every woff2 binary on the first-paint critical path.
 *
 * We now load each family on demand: once when `init()` sees the persisted
 * choice and again whenever a setter changes it. Each dynamic import lands
 * in its own Vite-emitted chunk, so the startup bundle no longer carries
 * any font payload. The CSS side-effect injects `@font-face` rules into
 * the document; repeat calls are deduped by the browser's module cache.
 *
 * The `system` keys do NOT resolve to "no webfont" — the default stacks
 * still list JetBrains Mono + Fira Code as first preferences, so we load
 * those lazily too when the user keeps the default. This preserves the
 * pre-fix visual appearance of code blocks on systems where the fonts
 * aren't installed; the only behavioural difference is a brief FOUT on
 * first launch before the chunk resolves. On subsequent launches the
 * browser cache makes the swap unobservable.
 *
 * Each loader is memoised so the same import() promise is reused and a
 * family can be preloaded in parallel with the rest of the app shell
 * without triggering duplicate network requests.
 */
const loadedPromises = new Map<string, Promise<unknown>>();

/** Fire-and-forget: resolve a family's `@font-face` CSS and inject it. */
function loadFontCss(id: string, loader: () => Promise<unknown>): void {
  if (loadedPromises.has(id)) return;
  let p: Promise<unknown>;
  try {
    p = loader();
  } catch {
    // import() can throw synchronously in environments without a module
    // runner (jsdom during unit tests). A missing webfont is a visual
    // fallback, never fatal — swallow and pretend success so the store
    // stays test-friendly.
    p = Promise.resolve();
  }
  loadedPromises.set(id, p.catch(() => undefined));
}

function loadBodyWebfont(key: BodyFont): void {
  switch (key) {
    case "inter":
      loadFontCss("inter-400", () => import("@fontsource/inter/400.css"));
      loadFontCss("inter-700", () => import("@fontsource/inter/700.css"));
      return;
    case "lora":
      loadFontCss("lora-400", () => import("@fontsource/lora/400.css"));
      loadFontCss("lora-700", () => import("@fontsource/lora/700.css"));
      return;
    case "system":
      // System stack has no webfont — fallbacks only.
      return;
  }
}

function loadMonoWebfont(key: MonoFont): void {
  // Both the "system" default stack and the explicit choices reference
  // JetBrains Mono / Fira Code. Load whichever the chosen stack names
  // first; in "system" mode we load both so the stack degrades in order.
  switch (key) {
    case "jetbrains-mono":
      loadFontCss("jetbrains-mono-400", () => import("@fontsource/jetbrains-mono/400.css"));
      loadFontCss("jetbrains-mono-700", () => import("@fontsource/jetbrains-mono/700.css"));
      return;
    case "fira-code":
      loadFontCss("fira-code-400", () => import("@fontsource/fira-code/400.css"));
      loadFontCss("fira-code-700", () => import("@fontsource/fira-code/700.css"));
      return;
    case "system":
      loadFontCss("jetbrains-mono-400", () => import("@fontsource/jetbrains-mono/400.css"));
      loadFontCss("jetbrains-mono-700", () => import("@fontsource/jetbrains-mono/700.css"));
      loadFontCss("fira-code-400", () => import("@fontsource/fira-code/400.css"));
      loadFontCss("fira-code-700", () => import("@fontsource/fira-code/700.css"));
      return;
  }
}

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 14;

/** Upper bound for persisted daily-notes strings — defensive against a
 *  tampered localStorage entry growing without bound. Real paths/formats
 *  fit in well under this. */
const DAILY_STRING_MAX = 512;

const K_BODY = "vaultcore-font-body";
const K_MONO = "vaultcore-font-mono";
const K_SIZE = "vaultcore-font-size";
const K_DAILY_FOLDER = "vaultcore-daily-notes-folder";
const K_DAILY_FORMAT = "vaultcore-daily-notes-date-format";
const K_DAILY_TEMPLATE = "vaultcore-daily-notes-template";
// #201: semantic-search master toggle. When true, the next vault-open
// triggers an initial reindex; toggling to false cancels any in-flight
// reindex but does NOT delete prior embeddings.
const K_SEMANTIC = "vaultcore-semantic-search";
// Legacy key from the brief attachment-folder era (before embeds). Removed
// during cleanup so stale entries don't linger in localStorage.
const K_ATTACHMENT_FOLDER_LEGACY = "vaultcore-attachment-folder";
// #345: auto-lock timer for encrypted folders. Persisted as minutes.
// 0 means "never auto-lock" (still re-locks on app quit).
const K_AUTO_LOCK_MINUTES = "vaultcore-auto-lock-minutes";

export const AUTO_LOCK_MINUTES_MIN = 0;
export const AUTO_LOCK_MINUTES_MAX = 120;
export const AUTO_LOCK_MINUTES_DEFAULT = 15;

export interface SettingsState {
  fontBody: BodyFont;
  fontMono: MonoFont;
  fontSize: number;
  /** Vault-relative folder for daily notes. Empty = vault root. */
  dailyNotesFolder: string;
  /** Token string understood by `formatDailyNoteDate` (YYYY / MM / DD). */
  dailyNotesDateFormat: string;
  /** Vault-relative path to a template file. Empty = no template. */
  dailyNotesTemplate: string;
  /** #201: master toggle for semantic search. Off by default so the
   *  reindex never runs until the user opts in. */
  enableSemanticSearch: boolean;
  /** #345: auto-lock timeout in minutes. 0 disables auto-lock. */
  autoLockMinutes: number;
}

const initial: SettingsState = {
  fontBody: "system",
  fontMono: "system",
  fontSize: FONT_SIZE_DEFAULT,
  dailyNotesFolder: "",
  dailyNotesDateFormat: DEFAULT_DAILY_DATE_FORMAT,
  dailyNotesTemplate: "",
  enableSemanticSearch: false,
  autoLockMinutes: AUTO_LOCK_MINUTES_DEFAULT,
};

function isBodyFont(v: unknown): v is BodyFont {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BODY_STACKS, v);
}
function isMonoFont(v: unknown): v is MonoFont {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(MONO_STACKS, v);
}
function clampSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(n)));
}

/** Validate-on-read for the three daily-notes strings: must be a string and
 *  within a sensible length. Anything else falls back to the default. */
function sanitizeDailyString(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  if (v.length > DAILY_STRING_MAX) return fallback;
  return v;
}

function readInitial(): SettingsState {
  try {
    const b = localStorage.getItem(K_BODY);
    const m = localStorage.getItem(K_MONO);
    const s = Number(localStorage.getItem(K_SIZE));
    const dFolder = localStorage.getItem(K_DAILY_FOLDER);
    const dFormat = localStorage.getItem(K_DAILY_FORMAT);
    const dTemplate = localStorage.getItem(K_DAILY_TEMPLATE);
    const semantic = localStorage.getItem(K_SEMANTIC);
    const autoLockRaw = Number(localStorage.getItem(K_AUTO_LOCK_MINUTES));
    return {
      fontBody: isBodyFont(b) ? b : initial.fontBody,
      fontMono: isMonoFont(m) ? m : initial.fontMono,
      fontSize: Number.isFinite(s) && s > 0 ? clampSize(s) : FONT_SIZE_DEFAULT,
      dailyNotesFolder: sanitizeDailyString(dFolder, initial.dailyNotesFolder),
      dailyNotesDateFormat: sanitizeDailyString(dFormat, initial.dailyNotesDateFormat),
      dailyNotesTemplate: sanitizeDailyString(dTemplate, initial.dailyNotesTemplate),
      enableSemanticSearch: semantic === "true",
      autoLockMinutes:
        Number.isFinite(autoLockRaw) && autoLockRaw >= AUTO_LOCK_MINUTES_MIN
          ? Math.min(AUTO_LOCK_MINUTES_MAX, Math.round(autoLockRaw))
          : AUTO_LOCK_MINUTES_DEFAULT,
    };
  } catch { return { ...initial }; }
}

function createSettingsStore() {
  const _store = writable<SettingsState>({ ...initial });
  const applyBody = (key: BodyFont) =>
    document.documentElement.style.setProperty("--vc-font-body", BODY_STACKS[key]);
  const applyMono = (key: MonoFont) =>
    document.documentElement.style.setProperty("--vc-font-mono", MONO_STACKS[key]);
  const applySize = (n: number) =>
    document.documentElement.style.setProperty("--vc-font-size", `${n}px`);

  return {
    subscribe: _store.subscribe,
    init(): void {
      const s = readInitial();
      _store.set(s);
      applyBody(s.fontBody);
      applyMono(s.fontMono);
      applySize(s.fontSize);
      // #255: kick off the webfont CSS chunks now (after Svelte mount,
      // off the first-paint critical path). Fire-and-forget — the CSS
      // self-installs its @font-face rules when it lands.
      loadBodyWebfont(s.fontBody);
      loadMonoWebfont(s.fontMono);
      // One-shot cleanup of the legacy attachment-folder key. Safe to drop
      // after a few release cycles — kept here for now so upgraded users
      // don't carry stale state forever.
      try { localStorage.removeItem(K_ATTACHMENT_FOLDER_LEGACY); } catch { /* */ }
    },
    setFontBody(key: BodyFont): void {
      if (!isBodyFont(key)) return;
      _store.update((s) => ({ ...s, fontBody: key }));
      applyBody(key);
      loadBodyWebfont(key);
      try { localStorage.setItem(K_BODY, key); } catch { /* */ }
    },
    setFontMono(key: MonoFont): void {
      if (!isMonoFont(key)) return;
      _store.update((s) => ({ ...s, fontMono: key }));
      applyMono(key);
      loadMonoWebfont(key);
      try { localStorage.setItem(K_MONO, key); } catch { /* */ }
    },
    setFontSize(n: number): void {
      const clamped = clampSize(n);
      _store.update((s) => ({ ...s, fontSize: clamped }));
      applySize(clamped);
      try { localStorage.setItem(K_SIZE, String(clamped)); } catch { /* */ }
    },
    setDailyNotesFolder(value: string): void {
      const v = sanitizeDailyString(value, "");
      _store.update((s) => ({ ...s, dailyNotesFolder: v }));
      try { localStorage.setItem(K_DAILY_FOLDER, v); } catch { /* */ }
    },
    setDailyNotesDateFormat(value: string): void {
      // Empty format falls back to the default on read/use; we still persist
      // the literal empty string so the UI input can reflect it.
      const v = sanitizeDailyString(value, "");
      _store.update((s) => ({ ...s, dailyNotesDateFormat: v }));
      try { localStorage.setItem(K_DAILY_FORMAT, v); } catch { /* */ }
    },
    setDailyNotesTemplate(value: string): void {
      const v = sanitizeDailyString(value, "");
      _store.update((s) => ({ ...s, dailyNotesTemplate: v }));
      try { localStorage.setItem(K_DAILY_TEMPLATE, v); } catch { /* */ }
    },
    /** #201: persist the semantic-search master toggle. The caller owns
     *  wiring this to `reindexVault` / `cancelReindex`; this setter is
     *  storage-only so the flag can be read on next launch. */
    setEnableSemanticSearch(enable: boolean): void {
      _store.update((s) => ({ ...s, enableSemanticSearch: enable }));
      try { localStorage.setItem(K_SEMANTIC, String(enable)); } catch { /* */ }
    },
    /** #345: persist the auto-lock timeout. 0 disables the timer. */
    setAutoLockMinutes(n: number): void {
      const clamped = Number.isFinite(n)
        ? Math.max(
            AUTO_LOCK_MINUTES_MIN,
            Math.min(AUTO_LOCK_MINUTES_MAX, Math.round(n)),
          )
        : AUTO_LOCK_MINUTES_DEFAULT;
      _store.update((s) => ({ ...s, autoLockMinutes: clamped }));
      try { localStorage.setItem(K_AUTO_LOCK_MINUTES, String(clamped)); } catch { /* */ }
    },
  };
}

export const settingsStore = createSettingsStore();
