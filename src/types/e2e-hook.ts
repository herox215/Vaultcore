// Shape of the `window.__e2e__` harness exposed by src/App.svelte when
// VITE_E2E=1. This is the single source of truth — both the App.svelte
// setter and the e2e specs (see e2e/tsconfig.json) pick up the global
// augmentation from here so drivers can call methods directly without
// `as unknown as { ... }` casts.

export type E2eToastVariant = "error" | "conflict" | "clean-merge";

export interface E2eHook {
  loadVault: (path: string) => Promise<void>;
  switchVault: (path: string) => Promise<void>;
  closeVault: () => Promise<void>;
  pushToast: (variant: E2eToastVariant, message: string) => void;
  startProgress: (total: number) => void;
  updateProgress: (current: number, total: number, currentFile?: string) => void;
  finishProgress: () => void;
  typeInActiveEditor: (text: string) => Promise<void>;
  getActiveDocText: () => Promise<string>;
}

declare global {
  interface Window {
    __e2e__?: E2eHook;
  }
}
