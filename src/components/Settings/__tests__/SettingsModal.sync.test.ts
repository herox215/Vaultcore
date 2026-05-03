// UI-2 — component tests for the SYNCHRONISIERUNG section inside
// SettingsModal.svelte. Verifies section ordering, control bindings,
// revoke confirmation flow, clipboard copy, and editable device name
// commit-on-blur. Other Settings sections are stubbed to no-ops via
// store mocks so this suite stays focused on the new surface.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

// ── IPC mocks ─────────────────────────────────────────────────────────
//
// SettingsModal indirectly imports `../../ipc/commands` for `lockAllFolders`
// and the snippet IPC; the SYNC section adds the sync_* family. Mock the
// whole module — only the sync_* surface is exercised here.

vi.mock("../../../ipc/commands", () => ({
  syncGetSelfIdentity: vi.fn(),
  syncSetDeviceName: vi.fn(),
  syncGetDiscoverable: vi.fn(),
  syncSetDiscoverable: vi.fn(),
  syncListDiscoveredPeers: vi.fn(),
  syncListPairedPeers: vi.fn(),
  syncPairingStartInitiator: vi.fn(),
  syncPairingStartResponder: vi.fn(),
  syncPairingStep: vi.fn(),
  syncPairingConfirm: vi.fn(),
  syncPairingCancel: vi.fn(),
  syncGrantVault: vi.fn(),
  syncRevokePeer: vi.fn(),
  syncRevokeVaultGrant: vi.fn(),
  // unrelated commands SettingsModal imports
  lockAllFolders: vi.fn(),
  listSnippets: vi.fn(async () => []),
  readSnippet: vi.fn(),
}));

vi.mock("../../../ipc/events", () => ({
  listenPeersDiscovered: vi.fn(async () => () => {}),
  listenPeerPaired: vi.fn(async () => () => {}),
  listenSyncStatus: vi.fn(async () => () => {}),
  listenStalePeerResurrect: vi.fn(async () => () => {}),
}));

// Stub stores SettingsModal subscribes to so we don't need to bootstrap
// the whole app. We override only the slices the sync section depends on
// (selfIdentity, discoverable, pairedPeers, discoveredPeers, ready).
//
// `vi.mock` is hoisted to the top of the file, so the mock factories
// can't reference module-scope locals. We use `vi.hoisted(...)` to
// declare a shared bag that both the factories and the test bodies see.
import type {
  SelfIdentity,
  PairedPeer,
  DiscoveredPeer,
} from "../../../ipc/commands";

const stores = vi.hoisted(() => {
  // Have to require svelte/store inside the hoisted factory; top-level
  // imports run after `vi.hoisted`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writable } = require("svelte/store") as typeof import("svelte/store");
  return {
    selfIdentity: writable<unknown>(null),
    discoverable: writable<boolean>(false),
    pairedPeers: writable<unknown[]>([]),
    discoveredPeers: writable<unknown[]>([]),
    ready: writable<boolean>(true),
    setDiscoverable: vi.fn(),
    setDeviceName: vi.fn(),
    revokePeer: vi.fn(),
    openPairingModal: vi.fn(),
  };
});

vi.mock("../../../store/syncStore", () => ({
  selfIdentity: stores.selfIdentity,
  discoverable: stores.discoverable,
  pairedPeers: stores.pairedPeers,
  discoveredPeers: stores.discoveredPeers,
  syncStoreReady: stores.ready,
  setDiscoverable: (v: boolean) => stores.setDiscoverable(v),
  setDeviceName: (n: string) => stores.setDeviceName(n),
  revokePeer: (id: string) => stores.revokePeer(id),
}));

vi.mock("../../../store/pairingModalStore", () => ({
  openPairingModal: (peer?: DiscoveredPeer) => stores.openPairingModal(peer),
}));

// Freeze "now" so relativeTime() is deterministic.
vi.mock("../../../lib/relativeTime", () => ({
  relativeTime: (t: number | null | undefined) =>
    t == null ? "nie" : `vor ${1000 - t} Sekunden`,
  nowSeconds: () => 1000,
}));

import SettingsModal from "../SettingsModal.svelte";

function renderModal() {
  return render(SettingsModal, {
    props: {
      open: true,
      onClose: () => {},
      onSwitchVault: () => {},
    },
  });
}

beforeEach(() => {
  stores.selfIdentity.set({
    device_id: "ABCDEFGHIJKLMNOPQRSTUVWX",
    device_name: "Alice's Mac",
    pubkey_fingerprint: "AB12CD34",
  });
  stores.discoverable.set(false);
  stores.pairedPeers.set([]);
  stores.discoveredPeers.set([]);
  stores.setDiscoverable.mockReset();
  stores.setDeviceName.mockReset();
  stores.revokePeer.mockReset();
  stores.openPairingModal.mockReset();
});

describe("SettingsModal — SYNCHRONISIERUNG section", () => {
  it("renders after VAULT and before ERSCHEINUNGSBILD", () => {
    renderModal();
    const sections = Array.from(
      document.querySelectorAll(".vc-settings-section-title"),
    ).map((el) => el.textContent?.trim());
    const vaultIdx = sections.indexOf("VAULT");
    const syncIdx = sections.indexOf("SYNCHRONISIERUNG");
    const appearanceIdx = sections.indexOf("ERSCHEINUNGSBILD");
    expect(vaultIdx).toBeGreaterThanOrEqual(0);
    expect(syncIdx).toBeGreaterThan(vaultIdx);
    expect(appearanceIdx).toBeGreaterThan(syncIdx);
  });

  it("toggling discoverable dispatches setDiscoverable", async () => {
    renderModal();
    const toggle = screen.getByLabelText(
      "Dieses Gerät im Netzwerk sichtbar machen",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await fireEvent.click(toggle);
    expect(stores.setDiscoverable).toHaveBeenCalledWith(true);
  });

  it("renders each paired peer row with revoke aria-label", () => {
    stores.pairedPeers.set([
      {
        device_id: "PEER01",
        device_name: "Bob's Laptop",
        last_seen: 800,
        grants: [{ vault_id: "v1", vault_name: "Notes", scope: "read+write" }],
      },
      {
        device_id: "PEER02",
        device_name: "Bob's Phone",
        last_seen: null,
        grants: [],
      },
    ]);
    renderModal();
    expect(
      screen.getByLabelText("Synchronisierung mit Bob's Laptop widerrufen"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Synchronisierung mit Bob's Phone widerrufen"),
    ).toBeTruthy();
    expect(screen.getByText("Bob's Laptop")).toBeTruthy();
    expect(screen.getByText("Bob's Phone")).toBeTruthy();
  });

  it("renders the empty-paired hint when no peers are paired", () => {
    stores.pairedPeers.set([]);
    renderModal();
    expect(screen.getByText("Noch keine gekoppelten Geräte.")).toBeTruthy();
  });

  it("revoke button confirms then dispatches revokePeer; cancel does nothing", async () => {
    stores.pairedPeers.set([
      {
        device_id: "PEER01",
        device_name: "Bob's Laptop",
        last_seen: 900,
        grants: [],
      },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    renderModal();
    const btn = screen.getByLabelText(
      "Synchronisierung mit Bob's Laptop widerrufen",
    );
    await fireEvent.click(btn);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(stores.revokePeer).not.toHaveBeenCalled();

    confirmSpy.mockReturnValueOnce(true);
    await fireEvent.click(btn);
    expect(stores.revokePeer).toHaveBeenCalledWith("PEER01");
    confirmSpy.mockRestore();
  });

  it("copy-device-id button writes the device id to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderModal();
    const copyBtn = screen.getByLabelText("Geräte-ID kopieren");
    await fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("ABCDEFGHIJKLMNOPQRSTUVWX");
  });

  it("editable device name commits on blur", async () => {
    renderModal();
    const input = screen.getByLabelText("Gerätename") as HTMLInputElement;
    expect(input.value).toBe("Alice's Mac");
    input.value = "Alice's MacBook";
    await fireEvent.input(input);
    await fireEvent.blur(input);
    expect(stores.setDeviceName).toHaveBeenCalledWith("Alice's MacBook");
  });

  it("editable device name does NOT dispatch when value is unchanged", async () => {
    renderModal();
    const input = screen.getByLabelText("Gerätename") as HTMLInputElement;
    await fireEvent.blur(input);
    expect(stores.setDeviceName).not.toHaveBeenCalled();
  });

  it("'Neues Gerät koppeln…' button opens the pairing modal", async () => {
    renderModal();
    const btn = screen.getByText("Neues Gerät koppeln…");
    await fireEvent.click(btn);
    expect(stores.openPairingModal).toHaveBeenCalledTimes(1);
    expect(stores.openPairingModal.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("clicking a discovered peer opens the pairing modal pre-filled", async () => {
    const peer: DiscoveredPeer = {
      device_id: "PEER42",
      device_name: "Carol's iPad",
      vaults: [],
      addr: "192.168.1.42:7878",
    };
    stores.discoveredPeers.set([peer]);
    renderModal();
    const btn = screen.getByLabelText("Mit Carol's iPad koppeln");
    await fireEvent.click(btn);
    expect(stores.openPairingModal).toHaveBeenCalledWith(peer);
  });
});
