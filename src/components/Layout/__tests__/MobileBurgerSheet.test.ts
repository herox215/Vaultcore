/**
 * MobileBurgerSheet — bottom-sheet router for the mobile More tab (#397).
 *
 * Parent-gated: VaultLayout decides via `{#if isMobile && open}` (well,
 * just passes `open`); the component itself does NOT subscribe to
 * viewportStore. Heavy panel children (Backlinks/Bookmarks/Outline/
 * Outgoing) are stubbed via vi.mock so the mount budget stays tight and
 * we can probe the routing layer without dragging in the panels' own
 * dependency graphs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../Backlinks/BacklinksPanel.svelte", async () => ({
  default: (await import("./testStubs/StubPanel.svelte")).default,
}));
vi.mock("../../Bookmarks/BookmarksPanel.svelte", async () => ({
  default: (await import("./testStubs/StubPanel.svelte")).default,
}));
vi.mock("../../Outline/OutlinePanel.svelte", async () => ({
  default: (await import("./testStubs/StubPanel.svelte")).default,
}));
vi.mock("../../OutgoingLinks/OutgoingLinksPanel.svelte", async () => ({
  default: (await import("./testStubs/StubPanel.svelte")).default,
}));

// vi.mock factories are hoisted above any normal `const`, so a captured
// vi.fn() reference would be uninitialized at mock-evaluation time. The
// hoisted helper resolves that — same pattern as the viewportStore mock
// shape from #386's responsive-collapse spec.
const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock("../../../store/toastStore", () => ({
  toastStore: {
    info: toastInfo,
    push: vi.fn(),
    error: vi.fn(),
  },
}));

import MobileBurgerSheet from "../MobileBurgerSheet.svelte";

beforeEach(() => {
  toastInfo.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

function renderSheet(
  overrides: Partial<{
    open: boolean;
    onClose: () => void;
    onSelectProperties: () => void;
    onOpenSettings: () => void;
  }> = {},
) {
  return render(MobileBurgerSheet, {
    props: {
      open: true,
      onClose: vi.fn(),
      onSelectProperties: vi.fn(),
      onOpenSettings: vi.fn(),
      ...overrides,
    },
  });
}

describe("MobileBurgerSheet (#397)", () => {
  it("renders nothing when open=false", () => {
    const { container } = renderSheet({ open: false });
    expect(container.querySelector(".vc-mobile-burger-sheet")).toBeNull();
    expect(container.querySelector(".vc-modal-scrim")).toBeNull();
  });

  it("renders the menu view with 6 rows when open=true", () => {
    const { container } = renderSheet();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const rows = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(rows.length).toBe(6);
  });

  it("dialog carries aria-modal=true and aria-label='More options' in the menu view", () => {
    const { container } = renderSheet();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("More options");
  });

  it("clicking the Backlinks row swaps the menu view for the Backlinks panel", async () => {
    const { container } = renderSheet();
    const row = container.querySelector<HTMLButtonElement>('[data-row-id="backlinks"]');
    expect(row).not.toBeNull();
    await fireEvent.click(row!);
    await tick();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // Stub renders `<div data-stub-panel>...</div>`
    expect(container.querySelector("[data-stub-panel]")).not.toBeNull();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Backlinks");
  });

  it.each([
    ["bookmarks", "Lesezeichen"],
    ["outline", "Gliederung"],
    ["outgoing", "Ausgehende Links"],
  ])("clicking the %s row routes to a panel view labelled '%s'", async (rowId, label) => {
    const { container } = renderSheet();
    const row = container.querySelector<HTMLButtonElement>(`[data-row-id="${rowId}"]`);
    await fireEvent.click(row!);
    await tick();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe(label);
    expect(container.querySelector("[data-stub-panel]")).not.toBeNull();
  });

  it("clicking the Properties row calls onSelectProperties AND onClose, NOT toastStore.info (#393)", async () => {
    // #393 replaced the old toast stub with a real destination: the
    // burger sheet emits onSelectProperties so the parent can flip
    // its `mobilePropertiesOpen` flag, then closes itself so the two
    // sheets never co-render.
    const onClose = vi.fn();
    const onSelectProperties = vi.fn();
    const { container } = renderSheet({ onClose, onSelectProperties });
    const row = container.querySelector<HTMLButtonElement>('[data-row-id="properties"]');
    await fireEvent.click(row!);
    expect(onSelectProperties).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("clicking the Settings row calls onOpenSettings AND onClose (#394 wired)", async () => {
    // #394 replaces the old stub-toast with a real callback. The row no
    // longer fires toastStore.info — the parent (VaultLayout) now opens
    // the mobile settings sheet via the onOpenSettings callback.
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    const { container } = renderSheet({ onClose, onOpenSettings });
    const row = container.querySelector<HTMLButtonElement>('[data-row-id="settings"]');
    await fireEvent.click(row!);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("Settings row calls onClose BEFORE onOpenSettings (focus-race regression)", async () => {
    // Aristotle iter 1 #394 finding #2: opening the target sheet first
    // schedules its focus-to-first-focusable microtask, but the burger's
    // synchronous wasOpen latch then yanks focus to the More tab when
    // the close fires after — race lost. Closing first lets the latch
    // resolve synchronously, then the target sheet's microtask wins.
    const order: string[] = [];
    const onClose = vi.fn(() => { order.push("close"); });
    const onOpenSettings = vi.fn(() => { order.push("open"); });
    const { container } = renderSheet({ onClose, onOpenSettings });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="settings"]')!);
    expect(order).toEqual(["close", "open"]);
  });

  it("clicking the scrim calls onClose", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    const scrim = container.querySelector<HTMLElement>(".vc-mobile-burger-scrim");
    expect(scrim).not.toBeNull();
    await fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the Back button in the panel view returns to the menu view (does NOT close)", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="backlinks"]')!);
    await tick();
    const back = container.querySelector<HTMLButtonElement>(".vc-mobile-burger-back");
    expect(back).not.toBeNull();
    await fireEvent.click(back!);
    await tick();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focus trap: Tab from the last focusable wraps to the first; Shift+Tab from first wraps to last", async () => {
    const { container } = renderSheet();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(buttons.length).toBe(6);
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;

    // Forward wrap.
    last.focus();
    expect(document.activeElement).toBe(last);
    await fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Backward wrap.
    first.focus();
    await fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("focus trap: Tab away from a middle item does NOT preventDefault (browser handles native tab order)", async () => {
    // The trap only kicks in at boundaries (first/last). Middle items
    // should let the browser's native tab order through — a noop preventDefault
    // would feel sluggish without changing user-visible behaviour.
    const { container } = renderSheet();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const middle = buttons[2]!;
    middle.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("Escape from menu view calls onClose; Escape from panel view returns to menu", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    // Menu view: Escape closes.
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Panel view: Escape returns to menu (does not close).
    onClose.mockClear();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="outline"]')!);
    await tick();
    await fireEvent.keyDown(container.querySelector<HTMLElement>('[role="dialog"]')!, { key: "Escape" });
    await tick();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-opening the sheet resets to the menu view (active panel doesn't persist)", async () => {
    const onClose = vi.fn();
    const { container, rerender } = renderSheet({ open: true, onClose });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-row-id="bookmarks"]')!);
    await tick();
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await rerender({ open: false, onClose });
    await tick();
    await rerender({ open: true, onClose });
    await tick();

    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("More options");
  });

  it("does not import viewportStore — parent-gated component is the architectural contract", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const componentPath = url.fileURLToPath(import.meta.resolve("../MobileBurgerSheet.svelte"));
    const src = await fs.readFile(componentPath, "utf8");
    expect(/from\s+["'][^"']*viewportStore["']/.test(src)).toBe(false);
  });
});
