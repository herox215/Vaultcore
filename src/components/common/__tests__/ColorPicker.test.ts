// #166 — shared ColorPicker. Locks in the swatch-click / Clear / ESC /
// overlay-close behaviour so future consumers (group background, edge
// color, potential future node colouring) can share one primitive.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import ColorPickerHarness from "./ColorPickerHarness.svelte";

describe("ColorPicker (#166)", () => {
  it("renders swatches + clear + custom input when open", async () => {
    const { container } = render(ColorPickerHarness, {
      props: { open: true, x: 50, y: 50 },
    });
    await tick();
    expect(container.querySelector(".vc-color-picker")).toBeTruthy();
    expect(container.querySelectorAll(".vc-color-swatch").length).toBeGreaterThanOrEqual(8);
    expect(container.querySelector(".vc-color-clear")).toBeTruthy();
    expect(container.querySelector('input[type="color"]')).toBeTruthy();
  });

  it("does not render when closed", async () => {
    const { container } = render(ColorPickerHarness, {
      props: { open: false, x: 0, y: 0 },
    });
    await tick();
    expect(container.querySelector(".vc-color-picker")).toBeNull();
    expect(container.querySelector(".vc-color-overlay")).toBeNull();
  });

  it("clicking a swatch emits its hex and closes", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ColorPickerHarness, {
      props: { open: true, onChange, onClose },
    });
    await tick();
    const swatch = container.querySelector('.vc-color-swatch[data-color="#22c55e"]') as HTMLButtonElement;
    await fireEvent.click(swatch);
    expect(onChange).toHaveBeenCalledWith("#22c55e");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Clear emits null and closes", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ColorPickerHarness, {
      props: { open: true, value: "#ef4444", onChange, onClose },
    });
    await tick();
    const clear = container.querySelector(".vc-color-clear") as HTMLButtonElement;
    await fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("custom color input emits its value without closing", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ColorPickerHarness, {
      props: { open: true, onChange, onClose },
    });
    await tick();
    const input = container.querySelector('input[type="color"]') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "#abcdef" } });
    expect(onChange).toHaveBeenCalledWith("#abcdef");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(ColorPickerHarness, { props: { open: true, onClose } });
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the overlay closes", async () => {
    const onClose = vi.fn();
    const { container } = render(ColorPickerHarness, { props: { open: true, onClose } });
    await tick();
    const overlay = container.querySelector(".vc-color-overlay") as HTMLElement;
    await fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("marks the active swatch", async () => {
    const { container } = render(ColorPickerHarness, {
      props: { open: true, value: "#8b5cf6" },
    });
    await tick();
    const active = container.querySelector(".vc-color-swatch-active") as HTMLElement;
    expect(active?.getAttribute("data-color")).toBe("#8b5cf6");
  });
});
