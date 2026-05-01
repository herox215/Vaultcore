/**
 * MobileSettingsSheet — full-screen settings sheet for mobile (#394).
 *
 * Parent-gated: VaultLayout decides via `{#if isMobile}`; the component
 * doesn't subscribe to viewportStore. Per team-lead direction this is a
 * full-screen, opaque sheet — no scrim, just an X close button + Escape.
 *
 * Master/detail navigation: a category list (master view) drills into a
 * single-category detail view. Two-step Escape (detail → master → close)
 * matches the burger-sheet pattern from #397.
 *
 * Stores are mocked so we can assert call shape without exercising
 * theme/font side-effects on the test DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

const { themeSet, settingsCalls, fakeSettingsState } = vi.hoisted(() => ({
  themeSet: vi.fn(),
  settingsCalls: {
    setFontBody: vi.fn(),
    setFontMono: vi.fn(),
    setFontSize: vi.fn(),
    setDailyNotesFolder: vi.fn(),
    setDailyNotesDateFormat: vi.fn(),
    setDailyNotesTemplate: vi.fn(),
    setAutoLockMinutes: vi.fn(),
  },
  fakeSettingsState: {
    fontBody: "system" as const,
    fontMono: "system" as const,
    fontSize: 14,
    dailyNotesFolder: "Daily",
    dailyNotesDateFormat: "YYYY-MM-DD",
    dailyNotesTemplate: "",
    autoLockMinutes: 15,
  },
}));

vi.mock("../../../store/themeStore", () => {
  const subscribers = new Set<(t: string) => void>();
  return {
    themeStore: {
      subscribe: (cb: (t: string) => void) => {
        cb("auto");
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      set: (t: string) => {
        themeSet(t);
        subscribers.forEach((s) => s(t));
      },
    },
  };
});

vi.mock("../../../store/settingsStore", () => {
  const subscribers = new Set<(s: typeof fakeSettingsState) => void>();
  return {
    settingsStore: {
      subscribe: (cb: (s: typeof fakeSettingsState) => void) => {
        cb(fakeSettingsState);
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      ...settingsCalls,
    },
    FONT_SIZE_MIN: 12,
    FONT_SIZE_MAX: 20,
    AUTO_LOCK_MINUTES_MIN: 0,
    AUTO_LOCK_MINUTES_MAX: 120,
  };
});

vi.mock("../../../store/vaultStore", () => {
  type VaultLike = { currentPath: string | null };
  const state: VaultLike = { currentPath: "/test/vault" };
  const subscribers = new Set<(s: VaultLike) => void>();
  return {
    vaultStore: {
      subscribe: (cb: (s: VaultLike) => void) => {
        cb(state);
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
    },
  };
});

import MobileSettingsSheet from "../MobileSettingsSheet.svelte";

beforeEach(() => {
  themeSet.mockClear();
  Object.values(settingsCalls).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  document.body.innerHTML = "";
});

function renderSheet(overrides: Partial<{
  open: boolean;
  onClose: () => void;
  onSwitchVault: () => void;
}> = {}) {
  return render(MobileSettingsSheet, {
    props: {
      open: true,
      onClose: vi.fn(),
      onSwitchVault: vi.fn(),
      ...overrides,
    },
  });
}

describe("MobileSettingsSheet (#394)", () => {
  it("renders nothing when open=false", () => {
    const { container } = renderSheet({ open: false });
    expect(container.querySelector(".vc-mobile-settings-sheet")).toBeNull();
  });

  it("renders the master view with 5 category rows when open=true", () => {
    const { container } = renderSheet();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const rows = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(rows.length).toBe(5);
  });

  it("dialog is full-screen — no scrim element exists (per team-lead direction)", () => {
    const { container } = renderSheet();
    expect(container.querySelector(".vc-modal-scrim")).toBeNull();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Einstellungen");
  });

  it("clicking the Erscheinungsbild row swaps the master view for the appearance detail view", async () => {
    const { container } = renderSheet();
    const row = container.querySelector<HTMLButtonElement>('[data-row-id="appearance"]')!;
    await fireEvent.click(row);
    await tick();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="theme"]');
    expect(radios.length).toBe(3);
  });

  it("changing the theme radio dispatches themeStore.set", async () => {
    const { container } = renderSheet();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="appearance"]')!);
    await tick();
    const dark = container.querySelector<HTMLInputElement>('input[type="radio"][value="dark"]')!;
    await fireEvent.click(dark);
    expect(themeSet).toHaveBeenCalledWith("dark");
  });

  it("changing the font-size slider dispatches settingsStore.setFontSize with a numeric value", async () => {
    const { container } = renderSheet();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="fonts"]')!);
    await tick();
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider).not.toBeNull();
    await fireEvent.input(slider, { target: { value: "18" } });
    expect(settingsCalls.setFontSize).toHaveBeenCalledWith(18);
  });

  it("Vault → Switch vault button calls onSwitchVault", async () => {
    const onSwitchVault = vi.fn();
    const { container } = renderSheet({ onSwitchVault });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="vault"]')!);
    await tick();
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="settings-switch-vault"]')!;
    await fireEvent.click(btn);
    expect(onSwitchVault).toHaveBeenCalledTimes(1);
  });

  it("the Back button in detail view returns to the master view (does NOT close)", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="appearance"]')!);
    await tick();
    const back = container.querySelector<HTMLButtonElement>(".vc-mobile-settings-back")!;
    await fireEvent.click(back);
    await tick();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the X close button in master view calls onClose", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    const close = container.querySelector<HTMLButtonElement>(".vc-mobile-settings-close")!;
    await fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape from master view calls onClose; Escape from detail view returns to master", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;

    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="fonts"]')!);
    await tick();
    await fireEvent.keyDown(container.querySelector<HTMLElement>('[role="dialog"]')!, { key: "Escape" });
    await tick();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focus trap: Tab from the last focusable wraps to the first; Shift+Tab from first wraps to last", async () => {
    const { container } = renderSheet();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    // Master view focusables: close button + 5 menuitem rows = 6 items.
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"])'),
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    await fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    await fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("re-opening resets to the master view (active category doesn't persist)", async () => {
    const onClose = vi.fn();
    const { container, rerender } = renderSheet({ open: true, onClose });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="security"]')!);
    await tick();
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await rerender({ open: false, onClose, onSwitchVault: vi.fn() });
    await tick();
    await rerender({ open: true, onClose, onSwitchVault: vi.fn() });
    await tick();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("does not import viewportStore — parent-gated component is the architectural contract", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const componentPath = url.fileURLToPath(import.meta.resolve("../MobileSettingsSheet.svelte"));
    const src = await fs.readFile(componentPath, "utf8");
    expect(/from\s+["'][^"']*viewportStore["']/.test(src)).toBe(false);
  });
});
