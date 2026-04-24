// toastStore — UI-04 unified error surface.
// Classic Svelte `writable` per D-06 / RC-01. Caps at 3 stacked toasts
// (oldest evicted) and auto-dismisses each toast after 5000ms.

import { writable } from "svelte/store";

export type ToastVariant = "error" | "conflict" | "clean-merge" | "info" | "warning";

export interface Toast {
  id: number;
  variant: ToastVariant;
  message: string;
}

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 5000;

let nextId = 1;
const _store = writable<Toast[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

function dismiss(id: number): void {
  clearTimer(id);
  _store.update((toasts) => toasts.filter((t) => t.id !== id));
}

function scheduleDismiss(id: number): void {
  const t = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
  timers.set(id, t);
}

function pushToast(args: { variant: ToastVariant; message: string }): number {
  const id = nextId++;
  const toast: Toast = { id, variant: args.variant, message: args.message };
  _store.update((toasts) => {
    const next = [...toasts, toast];
    while (next.length > MAX_TOASTS) {
      const dropped = next.shift();
      if (dropped !== undefined) clearTimer(dropped.id);
    }
    return next;
  });
  scheduleDismiss(id);
  return id;
}

export const toastStore = {
  subscribe: _store.subscribe,
  push: pushToast,
  dismiss,
  /** Convenience: push an error-variant toast. */
  error(message: string): number {
    return pushToast({ variant: "error", message });
  },
  /** Convenience: push an info-variant toast (used for success notifications). */
  info(message: string): number {
    return pushToast({ variant: "info", message });
  },
  /** Test-only helper — resets in-memory state between Vitest cases. */
  _reset(): void {
    for (const id of Array.from(timers.keys())) clearTimer(id);
    nextId = 1;
    _store.set([]);
  },
};
