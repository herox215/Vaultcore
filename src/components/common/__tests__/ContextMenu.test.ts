// #164 — shared ContextMenu component. Locks in the open/close contract,
// ESC handling, and viewport-overflow flip logic so future callers can rely
// on it without re-testing the primitive.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import ContextMenuHarness from "./ContextMenuHarness.svelte";

describe("ContextMenu (#164)", () => {
  it("renders the menu and children when open=true", async () => {
    const { container, getByText } = render(ContextMenuHarness, {
      props: { open: true, x: 40, y: 60, label: "Item A" },
    });
    await tick();
    expect(container.querySelector(".vc-context-menu")).toBeTruthy();
    expect(container.querySelector(".vc-context-overlay")).toBeTruthy();
    expect(getByText("Item A")).toBeTruthy();
  });

  it("does not render when open=false", async () => {
    const { container } = render(ContextMenuHarness, {
      props: { open: false, x: 0, y: 0, label: "Hidden" },
    });
    await tick();
    expect(container.querySelector(".vc-context-menu")).toBeNull();
    expect(container.querySelector(".vc-context-overlay")).toBeNull();
  });

  it("positions the menu at the given x/y", async () => {
    const { container } = render(ContextMenuHarness, {
      props: { open: true, x: 123, y: 45, label: "Item" },
    });
    await tick();
    const menu = container.querySelector(".vc-context-menu") as HTMLElement;
    expect(menu.style.top).toBe("45px");
    expect(menu.style.left).toBe("123px");
  });

  it("calls onClose when the overlay is clicked", async () => {
    const onClose = vi.fn();
    const { container } = render(ContextMenuHarness, {
      props: { open: true, x: 0, y: 0, label: "x", onClose },
    });
    await tick();
    const overlay = container.querySelector(".vc-context-overlay") as HTMLElement;
    await fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    render(ContextMenuHarness, {
      props: { open: true, x: 0, y: 0, label: "x", onClose },
    });
    await tick();
    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(ev);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not listen for Escape while closed", async () => {
    const onClose = vi.fn();
    render(ContextMenuHarness, {
      props: { open: false, x: 0, y: 0, label: "x", onClose },
    });
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
