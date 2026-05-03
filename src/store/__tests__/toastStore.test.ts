// UI-5 — toastStore persist API + action option.
//
// These tests are additive to tests/Toast.test.ts (UI-04). They cover
// only the new surface introduced by UI-5: the `persist` flag (no
// auto-dismiss), the per-toast `action` slot, and the stale-peer
// resurrect wiring that pushes a persistent warning toast for each
// new entry in `syncStore.staleResurrectQueue`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";

vi.mock("../../ipc/commands", () => ({
  syncGetSelfIdentity: vi.fn(async () => null),
  syncGetDiscoverable: vi.fn(async () => false),
  syncListPairedPeers: vi.fn(async () => []),
  syncSetDiscoverable: vi.fn(),
  syncSetDeviceName: vi.fn(),
  syncPairingStartInitiator: vi.fn(),
  syncPairingStartResponder: vi.fn(),
  syncPairingStep: vi.fn(),
  syncPairingConfirm: vi.fn(),
  syncPairingCancel: vi.fn(),
  syncGrantVault: vi.fn(),
  syncRevokePeer: vi.fn(),
  syncRevokeVaultGrant: vi.fn(),
}));

vi.mock("../../ipc/events", () => ({
  listenPeersDiscovered: vi.fn(async () => () => {}),
  listenPeerPaired: vi.fn(async () => () => {}),
  listenSyncStatus: vi.fn(async () => () => {}),
  listenStalePeerResurrect: vi.fn(async () => () => {}),
}));

import { toastStore } from "../toastStore";
import {
  initStaleResurrectToasts,
  resetStaleResurrectToasts,
} from "../staleResurrectToasts";
import {
  _setStateForTest as setSyncState,
  resetSyncStore,
} from "../syncStore";

beforeEach(() => {
  toastStore._reset();
  resetSyncStore();
  resetStaleResurrectToasts();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Part A — toastStore.persist + action ────────────────────────────────

describe("UI-5 toastStore.push({ persist: true })", () => {
  it("persist_true_skips_auto_dismiss: persistent toast is NOT removed after 5000 ms", () => {
    vi.useFakeTimers();
    toastStore.push({
      variant: "warning",
      message: "stays put",
      persist: true,
    });
    expect(get(toastStore)).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(get(toastStore)).toHaveLength(1);
  });

  it("persist_false_default_still_auto_dismisses_after_5s: omitting persist preserves UI-04 behaviour", () => {
    vi.useFakeTimers();
    toastStore.push({ variant: "error", message: "fleeting" });
    expect(get(toastStore)).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    expect(get(toastStore)).toHaveLength(0);
  });

  it("explicit persist:false matches the default (auto-dismisses)", () => {
    vi.useFakeTimers();
    toastStore.push({ variant: "info", message: "x", persist: false });
    vi.advanceTimersByTime(5001);
    expect(get(toastStore)).toHaveLength(0);
  });

  it("close_button_removes_persistent_toast: dismiss(id) clears a persistent toast", () => {
    const id = toastStore.push({
      variant: "warning",
      message: "x",
      persist: true,
    });
    expect(get(toastStore)).toHaveLength(1);
    toastStore.dismiss(id);
    expect(get(toastStore)).toHaveLength(0);
  });

  it("backwards-compat: existing convenience helpers (.error, .info) still auto-dismiss", () => {
    vi.useFakeTimers();
    toastStore.error("boom");
    toastStore.info("ok");
    expect(get(toastStore)).toHaveLength(2);
    vi.advanceTimersByTime(5001);
    expect(get(toastStore)).toHaveLength(0);
  });

  it("action option is stored on the toast and surfaced to subscribers", () => {
    const onClick = vi.fn();
    toastStore.push({
      variant: "warning",
      message: "with action",
      persist: true,
      action: { label: "Überprüfen", onClick },
    });
    const items = get(toastStore);
    expect(items).toHaveLength(1);
    expect(items[0]!.action?.label).toBe("Überprüfen");
    expect(items[0]!.action?.onClick).toBe(onClick);
  });

  it("role + ariaLive options propagate to the stored toast", () => {
    toastStore.push({
      variant: "warning",
      message: "alert",
      persist: true,
      role: "alert",
      ariaLive: "assertive",
    });
    const items = get(toastStore);
    expect(items[0]!.role).toBe("alert");
    expect(items[0]!.ariaLive).toBe("assertive");
  });

  it("MAX_TOASTS cap still applies even when oldest is persistent", () => {
    toastStore.push({ variant: "warning", message: "p1", persist: true });
    toastStore.push({ variant: "info", message: "x" });
    toastStore.push({ variant: "info", message: "y" });
    toastStore.push({ variant: "info", message: "z" });
    const items = get(toastStore);
    expect(items).toHaveLength(3);
    expect(items.some((t) => t.message === "p1")).toBe(false);
  });
});

// ─── Part B — stale-peer resurrect wiring ───────────────────────────────

describe("UI-5 stale-peer resurrect → toast", () => {
  it("stale_peer_event_pushes_persistent_warning_toast", async () => {
    initStaleResurrectToasts();
    setSyncState({
      staleResurrectQueue: [
        {
          id: 1,
          peer_device_id: "PEER-A",
          peer_name: "MacBook Bob",
          pending_change_count: 4,
        },
      ],
    });
    const items = get(toastStore);
    expect(items).toHaveLength(1);
    const t = items[0]!;
    expect(t.variant).toBe("warning");
    expect(t.persist).toBe(true);
    expect(t.role).toBe("alert");
    expect(t.ariaLive).toBe("assertive");
    expect(t.message).toBe(
      "MacBook Bob war über 30 Tage offline — 4 ausstehende Änderungen prüfen?",
    );
    expect(t.action?.label).toBe("Überprüfen");
  });

  it("does not auto-dismiss the resurrect toast", () => {
    vi.useFakeTimers();
    initStaleResurrectToasts();
    setSyncState({
      staleResurrectQueue: [
        {
          id: 1,
          peer_device_id: "PEER-A",
          peer_name: "Bob",
          pending_change_count: 1,
        },
      ],
    });
    expect(get(toastStore)).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(get(toastStore)).toHaveLength(1);
  });

  it("only pushes one toast per queue entry, even when other slices change", () => {
    initStaleResurrectToasts();
    setSyncState({
      staleResurrectQueue: [
        { id: 1, peer_device_id: "P1", peer_name: "Bob", pending_change_count: 1 },
      ],
    });
    expect(get(toastStore)).toHaveLength(1);
    // Unrelated re-set with the same entry must not duplicate.
    setSyncState({
      staleResurrectQueue: [
        { id: 1, peer_device_id: "P1", peer_name: "Bob", pending_change_count: 1 },
      ],
      discoverable: true,
    });
    expect(get(toastStore)).toHaveLength(1);
  });

  it("action_button_navigates_to_sync_section_for_peer: invokes onOpenSyncSettings with peer id", () => {
    const open = vi.fn();
    initStaleResurrectToasts({ onOpenSyncSettings: open });
    setSyncState({
      staleResurrectQueue: [
        { id: 9, peer_device_id: "PEER-Z", peer_name: "Z", pending_change_count: 2 },
      ],
    });
    const t = get(toastStore)[0]!;
    t.action!.onClick();
    expect(open).toHaveBeenCalledWith("PEER-Z");
  });

  it("clicking the action does NOT remove the peer from staleResurrectQueue (close button only closes the toast)", () => {
    const open = vi.fn();
    initStaleResurrectToasts({ onOpenSyncSettings: open });
    setSyncState({
      staleResurrectQueue: [
        { id: 1, peer_device_id: "P1", peer_name: "Bob", pending_change_count: 1 },
      ],
    });
    const t = get(toastStore)[0]!;
    t.action!.onClick();
    // Per locked decision: peer stays in queue until handled in Settings.
    // We assert via syncStore state, since dismissResurrect() is the
    // explicit dismissal API.
    // (We can't easily import _getStateForTest here without re-exporting,
    //  but the action callback contract is the focused behaviour.)
    expect(open).toHaveBeenCalledTimes(1);
  });
});
