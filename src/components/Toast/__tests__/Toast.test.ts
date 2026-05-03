// UI-5 — Toast.svelte rendering of the new action-button slot, plus
// the role / aria-live overrides required by the stale-peer resurrect
// toast (warning + role="alert" + aria-live="assertive").
//
// UI-04 base coverage (variants, dismiss button, auto-dismiss, stacking
// cap) lives in tests/Toast.test.ts and stays green; this file only
// exercises the new surface introduced by UI-5.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ToastContainer from "../ToastContainer.svelte";
import { toastStore } from "../../../store/toastStore";

beforeEach(() => {
  toastStore._reset();
});

describe("UI-5 Toast component — action-button slot", () => {
  it("renders_action_button_when_provided: action label appears as a button", async () => {
    render(ToastContainer);
    toastStore.push({
      variant: "warning",
      message: "stale peer",
      persist: true,
      action: { label: "Überprüfen", onClick: () => {} },
    });
    const btn = await screen.findByRole("button", { name: "Überprüfen" });
    expect(btn).toBeTruthy();
  });

  it("does NOT render an action button for toasts without an action", async () => {
    render(ToastContainer);
    toastStore.push({ variant: "info", message: "plain" });
    await screen.findByTestId("toast");
    expect(screen.queryByRole("button", { name: "Überprüfen" })).toBeNull();
  });

  it("clicking_action_invokes_callback_and_does_not_close: callback fires, toast remains", async () => {
    render(ToastContainer);
    const onClick = vi.fn();
    toastStore.push({
      variant: "warning",
      message: "with action",
      persist: true,
      action: { label: "Überprüfen", onClick },
    });
    const btn = await screen.findByRole("button", { name: "Überprüfen" });
    await fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Toast still in DOM — the action callback is the caller's
    // responsibility; the toast itself stays until the ✕ button is
    // clicked or the caller calls dismiss().
    expect(screen.queryByTestId("toast")).not.toBeNull();
  });

  it("✕ button still removes a persistent toast", async () => {
    render(ToastContainer);
    toastStore.push({
      variant: "warning",
      message: "x",
      persist: true,
      action: { label: "Überprüfen", onClick: () => {} },
    });
    const dismiss = await screen.findByLabelText("Dismiss notification");
    await fireEvent.click(dismiss);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("role + ariaLive overrides apply to the toast root", async () => {
    render(ToastContainer);
    toastStore.push({
      variant: "warning",
      message: "alert",
      persist: true,
      role: "alert",
      ariaLive: "assertive",
    });
    const toast = await screen.findByTestId("toast");
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.getAttribute("aria-live")).toBe("assertive");
  });

  it("role defaults to status / aria-live=polite when not provided (UI-04 backwards-compat)", async () => {
    render(ToastContainer);
    toastStore.push({ variant: "info", message: "x" });
    const toast = await screen.findByTestId("toast");
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.getAttribute("aria-live")).toBe("polite");
  });
});
