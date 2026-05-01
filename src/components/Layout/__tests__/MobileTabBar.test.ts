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

function tabsOf(container: HTMLElement): [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement] {
  const list = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  if (list.length !== 3) throw new Error(`expected 3 tabs, got ${list.length}`);
  return list as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];
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
    const [files, search, more] = tabsOf(container);
    expect(files.getAttribute("aria-controls")).toBe("vc-mobile-drawer");
    expect(search.hasAttribute("aria-controls")).toBe(false);
    expect(more.hasAttribute("aria-controls")).toBe(false);
  });

  it("aria-selected is present on every tab — never omitted (ARIA tabs §3.23)", () => {
    const { container } = renderBar();
    for (const tab of tabsOf(container)) {
      expect(tab.hasAttribute("aria-selected")).toBe(true);
    }
  });

  it("when drawerOpen=false, every aria-selected is 'false'", () => {
    const { container } = renderBar({ drawerOpen: false });
    for (const tab of tabsOf(container)) {
      expect(tab.getAttribute("aria-selected")).toBe("false");
    }
  });

  it("when drawerOpen=true, Files tab is selected and others are not", () => {
    const { container } = renderBar({ drawerOpen: true });
    const [files, search, more] = tabsOf(container);
    expect(files.getAttribute("aria-selected")).toBe("true");
    expect(search.getAttribute("aria-selected")).toBe("false");
    expect(more.getAttribute("aria-selected")).toBe("false");
  });

  it("clicking each tab invokes the matching callback exactly once", async () => {
    const onSelectFiles = vi.fn();
    const onSelectSearch = vi.fn();
    const onSelectMore = vi.fn();
    const { container } = renderBar({ onSelectFiles, onSelectSearch, onSelectMore });
    const [files, search, more] = tabsOf(container);
    await fireEvent.click(files);
    await fireEvent.click(search);
    await fireEvent.click(more);
    expect(onSelectFiles).toHaveBeenCalledTimes(1);
    expect(onSelectSearch).toHaveBeenCalledTimes(1);
    expect(onSelectMore).toHaveBeenCalledTimes(1);
  });

  it("roving tabindex follows the active tab — Files is reachable when drawerOpen, none when closed", async () => {
    const { container, rerender } = renderBar({ drawerOpen: false });
    {
      const [files, search, more] = tabsOf(container);
      // No active tab → first tab carries tabindex=0 (entry point) per the
      // ARIA tabs pattern fallback.
      expect(files.getAttribute("tabindex")).toBe("0");
      expect(search.getAttribute("tabindex")).toBe("-1");
      expect(more.getAttribute("tabindex")).toBe("-1");
    }

    await rerender({
      drawerOpen: true,
      onSelectFiles: vi.fn(),
      onSelectSearch: vi.fn(),
      onSelectMore: vi.fn(),
    });
    await tick();
    const [files, search, more] = tabsOf(container);
    expect(files.getAttribute("tabindex")).toBe("0");
    expect(search.getAttribute("tabindex")).toBe("-1");
    expect(more.getAttribute("tabindex")).toBe("-1");
  });

  it("ArrowRight cycles focus forward and wraps; ArrowLeft cycles backward and wraps", async () => {
    const { container } = renderBar();
    const [files, search, more] = tabsOf(container);
    files.focus();
    expect(document.activeElement).toBe(files);

    await fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(document.activeElement).toBe(search);
    await fireEvent.keyDown(search, { key: "ArrowRight" });
    expect(document.activeElement).toBe(more);
    await fireEvent.keyDown(more, { key: "ArrowRight" });
    expect(document.activeElement).toBe(files);

    await fireEvent.keyDown(files, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(more);
  });

  it("Home jumps to the first tab; End jumps to the last", async () => {
    const { container } = renderBar();
    const [files, search, more] = tabsOf(container);
    search.focus();
    await fireEvent.keyDown(search, { key: "Home" });
    expect(document.activeElement).toBe(files);
    await fireEvent.keyDown(files, { key: "End" });
    expect(document.activeElement).toBe(more);
  });

  it("does not import viewportStore — parent-gated component is the architectural contract", async () => {
    // Verifies the v2 #4 fix: MobileTabBar must not self-gate on viewport.
    // Read the source instead of relying on a runtime probe (would still
    // pass if a vi.mock blocked the import at runtime). Match the import
    // statement specifically — the word may appear in a comment explaining
    // the contract, and that's fine.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    // import.meta.resolve goes through the runtime resolver — if the file
    // moves or is renamed, this throws loud rather than silently resolving
    // to a wrong path that happens to not contain the word.
    const componentPath = url.fileURLToPath(import.meta.resolve("../MobileTabBar.svelte"));
    const src = await fs.readFile(componentPath, "utf8");
    expect(/from\s+["'][^"']*viewportStore["']/.test(src)).toBe(false);
  });
});
