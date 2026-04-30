/**
 * MobileTabBar — bottom-nav for the mobile shell (#389).
 *
 * The component is parent-gated (VaultLayout decides via `{#if isMobile}`),
 * so this spec doesn't mock viewportStore — it just renders the component
 * directly and verifies the tablist contract: 3 tabs, ARIA tabs pattern,
 * roving tabindex, click-callbacks, and arrow-key navigation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import MobileTabBar from "../MobileTabBar.svelte";

afterEach(() => {
  document.body.innerHTML = "";
});

function renderBar(overrides: Partial<{
  drawerOpen: boolean;
  onSelectFiles: () => void;
  onSelectSearch: () => void;
  onSelectMore: () => void;
}> = {}) {
  return render(MobileTabBar, {
    props: {
      drawerOpen: false,
      onSelectFiles: vi.fn(),
      onSelectSearch: vi.fn(),
      onSelectMore: vi.fn(),
      ...overrides,
    },
  });
}

describe("MobileTabBar (#389)", () => {
  it("renders a tablist with 3 tabs and aria-label='Main navigation'", () => {
    const { container } = renderBar();
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist!.getAttribute("aria-label")).toBe("Main navigation");
    expect(container.querySelectorAll('[role="tab"]').length).toBe(3);
  });

  it("Files tab carries aria-controls='vc-mobile-drawer'; Search and More do not have aria-controls", () => {
    const { container } = renderBar();
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].getAttribute("aria-controls")).toBe("vc-mobile-drawer");
    expect(tabs[1].hasAttribute("aria-controls")).toBe(false);
    expect(tabs[2].hasAttribute("aria-controls")).toBe(false);
  });

  it("aria-selected is present on every tab — never omitted (ARIA tabs §3.23)", () => {
    const { container } = renderBar();
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    for (const tab of Array.from(tabs)) {
      expect(tab.hasAttribute("aria-selected")).toBe(true);
    }
  });

  it("when drawerOpen=false, every aria-selected is 'false'", () => {
    const { container } = renderBar({ drawerOpen: false });
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    for (const tab of Array.from(tabs)) {
      expect(tab.getAttribute("aria-selected")).toBe("false");
    }
  });

  it("when drawerOpen=true, Files tab is selected and others are not", () => {
    const { container } = renderBar({ drawerOpen: true });
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs[2].getAttribute("aria-selected")).toBe("false");
  });

  it("clicking each tab invokes the matching callback exactly once", async () => {
    const onSelectFiles = vi.fn();
    const onSelectSearch = vi.fn();
    const onSelectMore = vi.fn();
    const { container } = renderBar({ onSelectFiles, onSelectSearch, onSelectMore });
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    await fireEvent.click(tabs[0]);
    await fireEvent.click(tabs[1]);
    await fireEvent.click(tabs[2]);
    expect(onSelectFiles).toHaveBeenCalledTimes(1);
    expect(onSelectSearch).toHaveBeenCalledTimes(1);
    expect(onSelectMore).toHaveBeenCalledTimes(1);
  });

  it("roving tabindex follows the active tab — Files is reachable when drawerOpen, none when closed", async () => {
    const { container, rerender } = renderBar({ drawerOpen: false });
    let tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    // No active tab → first tab carries tabindex=0 (entry point) per the
    // ARIA tabs pattern fallback.
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
    expect(tabs[2].getAttribute("tabindex")).toBe("-1");

    await rerender({
      drawerOpen: true,
      onSelectFiles: vi.fn(),
      onSelectSearch: vi.fn(),
      onSelectMore: vi.fn(),
    });
    await tick();
    tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
    expect(tabs[2].getAttribute("tabindex")).toBe("-1");
  });

  it("ArrowRight cycles focus forward and wraps; ArrowLeft cycles backward and wraps", async () => {
    const { container } = renderBar();
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[0].focus();
    expect(document.activeElement).toBe(tabs[0]);

    await fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    await fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    await fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);

    await fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("Home jumps to the first tab; End jumps to the last", async () => {
    const { container } = renderBar();
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[1].focus();
    await fireEvent.keyDown(tabs[1], { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    await fireEvent.keyDown(tabs[0], { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("does not import viewportStore — parent-gated component is the architectural contract", async () => {
    // Verifies the v2 #4 fix: MobileTabBar must not self-gate on viewport.
    // Read the source instead of relying on a runtime probe (would still
    // pass if a vi.mock blocked the import at runtime).
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const path = await import("node:path");
    const componentPath = path.resolve(path.dirname(here), "..", "MobileTabBar.svelte");
    const src = await fs.readFile(componentPath, "utf8");
    expect(src.includes("viewportStore")).toBe(false);
  });
});
