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

type UnlockRequest = {
  kind: "unlock";
  folderPath: string;
  folderLabel: string;
  /** Optional callback after a successful unlock — e.g. openFileAsTab. */
  onUnlocked?: () => void;
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
  onUnlocked?: () => void,
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
