// toastStore — UI-04 unified error surface, extended in UI-5.
// Classic Svelte `writable` per D-06 / RC-01. Caps at 3 stacked toasts
// (oldest evicted) and auto-dismisses each toast after 5000ms unless
// the caller passes `persist: true` (UI-5: stale-peer resurrect must
// never auto-dismiss — user decision 3).

import { writable } from "svelte/store";

export type ToastVariant = "error" | "conflict" | "clean-merge" | "info" | "warning";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  variant: ToastVariant;
  message: string;
  /** UI-5: when true the toast stays until explicitly dismissed. */
  persist?: boolean;
  /** UI-5: optional inline action button rendered next to the message. */
  action?: ToastAction;
  /** UI-5: override the default ARIA role ("status"). Use "alert" for
   *  toasts that demand immediate attention (resurrect prompt). */
  role?: "status" | "alert";
  /** UI-5: override the default aria-live ("polite"). */
  ariaLive?: "polite" | "assertive";
}

export interface PushToastArgs {
  variant: ToastVariant;
  message: string;
  persist?: boolean;
  action?: ToastAction;
  role?: "status" | "alert";
  ariaLive?: "polite" | "assertive";
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

function pushToast(args: PushToastArgs): number {
  const id = nextId++;
  const toast: Toast = {
    id,
    variant: args.variant,
    message: args.message,
    persist: args.persist ?? false,
  };
  if (args.action !== undefined) toast.action = args.action;
  if (args.role !== undefined) toast.role = args.role;
  if (args.ariaLive !== undefined) toast.ariaLive = args.ariaLive;
  _store.update((toasts) => {
    const next = [...toasts, toast];
    while (next.length > MAX_TOASTS) {
      const dropped = next.shift();
      if (dropped !== undefined) clearTimer(dropped.id);
    }
    return next;
  });
  if (!toast.persist) scheduleDismiss(id);
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
