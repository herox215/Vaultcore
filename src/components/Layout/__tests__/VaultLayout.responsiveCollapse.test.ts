/**
 * VaultLayout responsive-collapse spec (#386).
 *
 * Most of the VaultLayout surface (IPC, encryption, autoLock listeners,
 * file-watcher streams) is mocked away — these tests only care about the
 * mobile-shell branch: drawer open/close, ARIA mirroring, mode reset on
 * resize, and the backlinks-command early-return on mobile.
 *
 * The viewportStore mock uses a writable store so individual tests can
 * flip mode between "mobile" and "desktop" mid-test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";

// ---- viewportStore mock ----------------------------------------------------
// A writable so tests can flip the mode mid-render. The `await` form of
// `vi.hoisted` lets us pull `writable` from svelte/store before any test-file
// imports run — `vi.mock` factories are hoisted to the very top.
const { viewportWritable } = await vi.hoisted(async () => {
  const { writable } = await import("svelte/store");
  return {
    viewportWritable: writable<{ mode: "mobile" | "desktop" | "tablet"; isCoarsePointer: boolean }>({
      mode: "mobile",
      isCoarsePointer: true,
    }),
  };
});
vi.mock("../../../store/viewportStore", () => ({
  viewportStore: viewportWritable,
  createViewportStore: () => viewportWritable,
}));

// ---- IPC + event mocks (VaultLayout imports these at module scope) ---------
vi.mock("../../../ipc/commands", () => ({
  createFile: vi.fn(),
  createFolder: vi.fn(),
  exportNoteHtml: vi.fn(),
  listDirectory: vi.fn().mockResolvedValue([]),
  pickSavePath: vi.fn(),
  readFile: vi.fn(),
  renderNoteHtml: vi.fn(),
  writeFile: vi.fn(),
  encryptFolder: vi.fn(),
  unlockFolder: vi.fn(),
  lockAllFolders: vi.fn(),
}));

vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
  listenEncryptDropProgress: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../../store/autoLockStore", () => ({
  attachAutoLockListeners: vi.fn(),
  armAutoLock: vi.fn(),
  disarmAutoLock: vi.fn(),
  resetAutoLockStore: vi.fn(),
}));

// EditorPane drags in the entire CodeMirror stack — replace it with a stub
// so the test mount stays cheap.
vi.mock("../../Editor/EditorPane.svelte", async () => {
  const Stub = (await import("./testStubs/EmptyComponent.svelte")).default;
  return { default: Stub };
});
vi.mock("../../Sidebar/Sidebar.svelte", async () => {
  const Stub = (await import("./testStubs/SidebarStub.svelte")).default;
  return { default: Stub };
});
vi.mock("../../Search/OmniSearch.svelte", async () => {
  const Stub = (await import("./testStubs/EmptyComponent.svelte")).default;
  return { default: Stub };
});
vi.mock("../../CommandPalette/CommandPalette.svelte", async () => {
  const Stub = (await import("./testStubs/EmptyComponent.svelte")).default;
  return { default: Stub };
});
vi.mock("../../TemplatePicker/TemplatePicker.svelte", async () => {
  const Stub = (await import("./testStubs/EmptyComponent.svelte")).default;
  return { default: Stub };
});
vi.mock("../RightSidebar.svelte", async () => {
  const Stub = (await import("./testStubs/EmptyComponent.svelte")).default;
  return { default: Stub };
});
vi.mock("../../Settings/SettingsModal.svelte", async () => {
  const Stub = (await import("./testStubs/EmptyComponent.svelte")).default;
  return { default: Stub };
});
vi.mock("../../Statusbar/EncryptionStatusbar.svelte", async () => {
  const Stub = (await import("./testStubs/EmptyComponent.svelte")).default;
  return { default: Stub };
});

import { render } from "@testing-library/svelte";
import VaultLayout from "../VaultLayout.svelte";
import { backlinksStore } from "../../../store/backlinksStore";
import { commandRegistry } from "../../../lib/commands/registry";
import { CMD_IDS } from "../../../lib/commands/defaultCommands";

beforeEach(() => {
  viewportWritable.set({ mode: "mobile", isCoarsePointer: true });
  // jsdom in this vitest config does not always wire `localStorage` onto the
  // global before $effect fires inside Svelte 5 component init. Stub a tiny
  // in-memory implementation so VaultLayout's onMount localStorage reads
  // don't crash the mount.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("VaultLayout — mobile drawer (#386)", () => {
  it("does not apply the mobile-open class until the trigger is clicked", async () => {
    const { container } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    const drawer = container.querySelector(".vc-layout-sidebar");
    expect(drawer).not.toBeNull();
    expect(drawer!.classList.contains("vc-layout-sidebar--mobile-open")).toBe(false);
  });

  it("opens the drawer when the hamburger trigger is clicked, closes via the scrim", async () => {
    const { container } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-controls="vc-mobile-drawer"]');
    expect(trigger).not.toBeNull();
    trigger!.click();
    await tick();

    const drawer = container.querySelector(".vc-layout-sidebar")!;
    expect(drawer.classList.contains("vc-layout-sidebar--mobile-open")).toBe(true);

    const scrim = container.querySelector<HTMLElement>(".vc-mobile-scrim");
    expect(scrim).not.toBeNull();
    scrim!.click();
    await tick();

    expect(drawer.classList.contains("vc-layout-sidebar--mobile-open")).toBe(false);
  });

  it("resets mobileDrawerOpen when viewport flips from mobile to desktop", async () => {
    const { container } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-controls="vc-mobile-drawer"]');
    trigger!.click();
    await tick();
    const drawer = container.querySelector(".vc-layout-sidebar")!;
    expect(drawer.classList.contains("vc-layout-sidebar--mobile-open")).toBe(true);

    viewportWritable.set({ mode: "desktop", isCoarsePointer: false });
    await tick();
    await tick();
    expect(drawer.classList.contains("vc-layout-sidebar--mobile-open")).toBe(false);
  });

  it("Escape closes an open drawer", async () => {
    const { container } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-controls="vc-mobile-drawer"]');
    trigger!.click();
    await tick();
    const drawer = container.querySelector(".vc-layout-sidebar")!;
    expect(drawer.classList.contains("vc-layout-sidebar--mobile-open")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    expect(drawer.classList.contains("vc-layout-sidebar--mobile-open")).toBe(false);
  });

  it("aria-hidden mirrors !mobileDrawerOpen on mobile, falls back to sidebarCollapsed otherwise", async () => {
    const { container } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    const drawer = container.querySelector(".vc-layout-sidebar")!;
    // Mobile + drawer closed → aria-hidden true.
    expect(drawer.getAttribute("aria-hidden")).toBe("true");

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-controls="vc-mobile-drawer"]');
    trigger!.click();
    await tick();
    expect(drawer.getAttribute("aria-hidden")).toBe("false");

    // Desktop: aria-hidden follows sidebarCollapsed (default false).
    viewportWritable.set({ mode: "desktop", isCoarsePointer: false });
    await tick();
    await tick();
    expect(drawer.getAttribute("aria-hidden")).toBe("false");
  });

  it("hides the right sidebar entirely on mobile (DOM absent)", async () => {
    const { container } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();
    expect(container.querySelector(".vc-layout-right-sidebar")).toBeNull();
    expect(container.querySelector(".vc-backlinks-toggle-btn")).toBeNull();
  });

  it("backlinks-toggle command is a no-op on mobile", async () => {
    render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    let snapshotOpen = false;
    const unsub = backlinksStore.subscribe((s) => {
      snapshotOpen = s.open;
    });
    const before = snapshotOpen;
    commandRegistry.execute(CMD_IDS.BACKLINKS_TOGGLE);
    expect(snapshotOpen).toBe(before);
    unsub();
  });
});
