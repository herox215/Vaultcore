/**
 * settingsStore — body/mono font family + editor font size (UI-02, D-08/D-09).
 *
 * Whitelist for font keys (T-05-02-02) maps safe tokens to full CSS stacks so
 * a tampered localStorage cannot inject `expression(...)` or `"; } body{…` into
 * the --vc-font-* custom properties.
 *
 * Pattern: classic writable factory (D-06/RC-01 locked). Do not refactor
 * to Svelte 5 $state runes.
 */
import { writable } from "svelte/store";

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

const K_BODY = "vaultcore-font-body";
const K_MONO = "vaultcore-font-mono";
const K_SIZE = "vaultcore-font-size";

export interface SettingsState {
  fontBody: BodyFont;
  fontMono: MonoFont;
  fontSize: number;
}

const initial: SettingsState = {
  fontBody: "system",
  fontMono: "system",
  fontSize: FONT_SIZE_DEFAULT,
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

function readInitial(): SettingsState {
  try {
    const b = localStorage.getItem(K_BODY);
    const m = localStorage.getItem(K_MONO);
    const s = Number(localStorage.getItem(K_SIZE));
    return {
      fontBody: isBodyFont(b) ? b : initial.fontBody,
      fontMono: isMonoFont(m) ? m : initial.fontMono,
      fontSize: Number.isFinite(s) && s > 0 ? clampSize(s) : FONT_SIZE_DEFAULT,
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
  };
}

export const settingsStore = createSettingsStore();
