/**
 * #395 — VaultLayout's `$effect` propagates `viewportStore.keyboardHeight`
 * as the `--vc-keyboard-height` CSS custom property on `documentElement`.
 * The effect's return cleanup MUST remove the property on unmount so a
 * re-mount (vault switch / HMR) starts clean — otherwise stale padding
 * could persist on `.vc-editor-container` for a brief window.
 *
 * Mock surface mirrors `VaultLayout.responsiveCollapse.test.ts`: heavy
 * children stubbed, IPC mocked, viewportStore mocked via a hoisted writable
 * so each test can flip `keyboardHeight` deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";

const { viewportWritable } = await vi.hoisted(async () => {
  const { writable } = await import("svelte/store");
  return {
    viewportWritable: writable<{
      mode: "mobile" | "desktop" | "tablet";
      isCoarsePointer: boolean;
      keyboardHeight: number;
    }>({
      mode: "mobile",
      isCoarsePointer: true,
      keyboardHeight: 0,
    }),
  };
});
vi.mock("../../../store/viewportStore", () => ({
  viewportStore: viewportWritable,
  createViewportStore: () => viewportWritable,
}));

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

beforeEach(() => {
  viewportWritable.set({ mode: "mobile", isCoarsePointer: true, keyboardHeight: 0 });
  // localStorage stub mirrors VaultLayout.responsiveCollapse.test.ts —
  // VaultLayout's onMount reads sidebar width.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  });
  // Always start each test from a clean :root.
  document.documentElement.style.removeProperty("--vc-keyboard-height");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--vc-keyboard-height");
});

describe("VaultLayout — --vc-keyboard-height CSS var (#395)", () => {
  it("sets --vc-keyboard-height on :root when keyboardHeight > 0", async () => {
    const { unmount } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    viewportWritable.set({ mode: "mobile", isCoarsePointer: true, keyboardHeight: 250 });
    await tick();

    expect(
      document.documentElement.style.getPropertyValue("--vc-keyboard-height"),
    ).toBe("250px");
    unmount();
  });

  it("updates --vc-keyboard-height when the store value changes", async () => {
    const { unmount } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    viewportWritable.set({ mode: "mobile", isCoarsePointer: true, keyboardHeight: 250 });
    await tick();
    expect(
      document.documentElement.style.getPropertyValue("--vc-keyboard-height"),
    ).toBe("250px");

    viewportWritable.set({ mode: "mobile", isCoarsePointer: true, keyboardHeight: 320 });
    await tick();
    expect(
      document.documentElement.style.getPropertyValue("--vc-keyboard-height"),
    ).toBe("320px");

    unmount();
  });

  it("removes --vc-keyboard-height from :root on unmount", async () => {
    const { unmount } = render(VaultLayout, { props: { onSwitchVault: () => {} } });
    await tick();

    viewportWritable.set({ mode: "mobile", isCoarsePointer: true, keyboardHeight: 250 });
    await tick();
    expect(
      document.documentElement.style.getPropertyValue("--vc-keyboard-height"),
    ).toBe("250px");

    unmount();
    await tick();

    expect(
      document.documentElement.style.getPropertyValue("--vc-keyboard-height"),
    ).toBe("");
  });
});
