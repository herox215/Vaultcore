// UI-4 — SyncStatusPill.
//
// Idle/healthy: nothing rendered.
// Syncing:     plain pill, role=status / aria-live=polite, non-interactive.
// Error:       pill becomes a button with role=alert, aria-live=assertive,
//              left-border accent, and clicking opens settings on the SYNC
//              section.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { SyncStatusPayload } from "../../../ipc/events";

const stores = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writable } = require("svelte/store") as typeof import("svelte/store");
  return {
    syncStatusByVault: writable<Record<string, SyncStatusPayload>>({}),
    requestOpenSettings: vi.fn(),
  };
});

vi.mock("../../../store/syncStore", () => ({
  syncStatusByVault: stores.syncStatusByVault,
}));

vi.mock("../../../store/settingsModalStore", () => ({
  requestOpenSettings: (anchor: "sync" | null) => stores.requestOpenSettings(anchor),
}));

import SyncStatusPill from "../SyncStatusPill.svelte";

beforeEach(() => {
  stores.syncStatusByVault.set({});
  stores.requestOpenSettings.mockReset();
});

describe("SyncStatusPill", () => {
  it("hidden when all vaults are idle (no peers, no in-flight files, no error)", () => {
    stores.syncStatusByVault.set({
      v1: { vault_id: "v1", peer_count: 0, in_flight_files: 0, error: null },
    });
    render(SyncStatusPill);
    expect(screen.queryByTestId("sync-status-pill")).toBeNull();
  });

  it("hidden when state is empty (no vaults reporting)", () => {
    render(SyncStatusPill);
    expect(screen.queryByTestId("sync-status-pill")).toBeNull();
  });

  it("shows count when at least one vault is syncing", () => {
    stores.syncStatusByVault.set({
      v1: { vault_id: "v1", peer_count: 2, in_flight_files: 5, error: null },
      v2: { vault_id: "v2", peer_count: 1, in_flight_files: 3, error: null },
    });
    render(SyncStatusPill);
    const pill = screen.getByTestId("sync-status-pill");
    expect(pill).toBeTruthy();
    // Aggregated across vaults: 3 peers · 8 files
    expect(pill.textContent).toContain("3 verbunden");
    expect(pill.textContent).toContain("8 Dateien");
    expect(pill.getAttribute("role")).toBe("status");
    expect(pill.getAttribute("aria-live")).toBe("polite");
    // Non-interactive in syncing state — must not be a button.
    expect(pill.tagName).toBe("DIV");
  });

  it("error overrides syncing — pill becomes a button with error border and alert role", () => {
    stores.syncStatusByVault.set({
      v1: { vault_id: "v1", peer_count: 0, in_flight_files: 0, error: "permission denied" },
      v2: { vault_id: "v2", peer_count: 1, in_flight_files: 4, error: null },
    });
    render(SyncStatusPill);
    const pill = screen.getByTestId("sync-status-pill");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("role")).toBe("alert");
    expect(pill.getAttribute("aria-live")).toBe("assertive");
    expect(pill.getAttribute("aria-label")).toBe(
      "Synchronisierungsfehler — Einstellungen öffnen",
    );
    expect(pill.classList.contains("vc-encrypt-bar-error")).toBe(true);
  });

  it("clicking the error pill requests settings open on the sync section", async () => {
    stores.syncStatusByVault.set({
      v1: { vault_id: "v1", peer_count: 0, in_flight_files: 0, error: "boom" },
    });
    render(SyncStatusPill);
    const pill = screen.getByTestId("sync-status-pill");
    await fireEvent.click(pill);
    expect(stores.requestOpenSettings).toHaveBeenCalledWith("sync");
  });

  it("syncing pill click is a no-op (not a button)", async () => {
    stores.syncStatusByVault.set({
      v1: { vault_id: "v1", peer_count: 1, in_flight_files: 1, error: null },
    });
    render(SyncStatusPill);
    const pill = screen.getByTestId("sync-status-pill");
    await fireEvent.click(pill);
    expect(stores.requestOpenSettings).not.toHaveBeenCalled();
  });
});
