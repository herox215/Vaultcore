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
// Legacy key from the brief attachment-folder era (before embeds). Removed
// during cleanup so stale entries don't linger in localStorage.
const K_ATTACHMENT_FOLDER_LEGACY = "vaultcore-attachment-folder";

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
}

const initial: SettingsState = {
  fontBody: "system",
  fontMono: "system",
  fontSize: FONT_SIZE_DEFAULT,
  dailyNotesFolder: "",
  dailyNotesDateFormat: DEFAULT_DAILY_DATE_FORMAT,
  dailyNotesTemplate: "",
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
    return {
      fontBody: isBodyFont(b) ? b : initial.fontBody,
      fontMono: isMonoFont(m) ? m : initial.fontMono,
      fontSize: Number.isFinite(s) && s > 0 ? clampSize(s) : FONT_SIZE_DEFAULT,
      dailyNotesFolder: sanitizeDailyString(dFolder, initial.dailyNotesFolder),
      dailyNotesDateFormat: sanitizeDailyString(dFormat, initial.dailyNotesDateFormat),
      dailyNotesTemplate: sanitizeDailyString(dTemplate, initial.dailyNotesTemplate),
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
      // One-shot cleanup of the legacy attachment-folder key. Safe to drop
      // after a few release cycles — kept here for now so upgraded users
      // don't carry stale state forever.
      try { localStorage.removeItem(K_ATTACHMENT_FOLDER_LEGACY); } catch { /* */ }
    },
    setFontBody(key: BodyFont): void {
      if (!isBodyFont(key)) return;
      _store.update((s) => ({ ...s, fontBody: key }));
      applyBody(key);
      try { localStorage.setItem(K_BODY, key); } catch { /* */ }
    },
    setFontMono(key: MonoFont): void {
      if (!isMonoFont(key)) return;
      _store.update((s) => ({ ...s, fontMono: key }));
      applyMono(key);
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
  };
}

export const settingsStore = createSettingsStore();
