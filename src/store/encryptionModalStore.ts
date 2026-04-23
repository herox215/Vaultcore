// #345 — central controller for the EncryptFolderModal and
// PasswordPromptModal components. VaultLayout mounts both at root
// level; TreeRow / CommandPalette / Settings call into this store
// to open them. Keeps modal state off the component that triggered
// the open (so the modal survives the sidebar scroll / virtualizer
// remounting the row that requested it).

import { writable } from "svelte/store";

type EncryptRequest = {
  kind: "encrypt";
  folderPath: string;
  folderLabel: string;
};

/**
 * Signature of the "unlock succeeded" callback. Widened to
 * `Promise<void> | void` ahead of 345.3 so callers can await further
 * IPC work (e.g. re-open a file tab, refetch backlinks) without
 * threading an extra `.then(...)` through the modal plumbing.
 */
export type UnlockCallback = () => void | Promise<void>;

type UnlockRequest = {
  kind: "unlock";
  folderPath: string;
  folderLabel: string;
  /** Optional callback after a successful unlock — e.g. openFileAsTab. */
  onUnlocked?: UnlockCallback;
};

type ActiveModal =
  | null
  | ({ error?: "wrong" | "crypto" | null } & EncryptRequest)
  | ({ error?: "wrong" | "crypto" | null } & UnlockRequest);

export const encryptionModal = writable<ActiveModal>(null);

export function openEncryptModal(folderPath: string, folderLabel: string): void {
  encryptionModal.set({ kind: "encrypt", folderPath, folderLabel });
}

export function openUnlockModal(
  folderPath: string,
  folderLabel: string,
  onUnlocked?: UnlockCallback,
): void {
  if (onUnlocked) {
    encryptionModal.set({ kind: "unlock", folderPath, folderLabel, onUnlocked });
  } else {
    encryptionModal.set({ kind: "unlock", folderPath, folderLabel });
  }
}

export function closeEncryptionModal(): void {
  encryptionModal.set(null);
}

export function setEncryptionModalError(error: "wrong" | "crypto"): void {
  encryptionModal.update((m) => (m ? { ...m, error } : m));
}
