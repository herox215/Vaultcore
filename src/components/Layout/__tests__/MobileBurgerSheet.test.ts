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

function renderSheet(overrides: Partial<{ open: boolean; onClose: () => void }> = {}) {
  return render(MobileBurgerSheet, {
    props: {
      open: true,
      onClose: vi.fn(),
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

  it("clicking the Properties row fires toastStore.info AND calls onClose (TODO #393)", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    const row = container.querySelector<HTMLButtonElement>('[data-row-id="properties"]');
    await fireEvent.click(row!);
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the Settings row fires toastStore.info AND calls onClose (TODO #394)", async () => {
    const onClose = vi.fn();
    const { container } = renderSheet({ onClose });
    const row = container.querySelector<HTMLButtonElement>('[data-row-id="settings"]');
    await fireEvent.click(row!);
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
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
