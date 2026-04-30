// BookmarksPanel long-press → context menu (#387). Touch parity for the
// existing right-click context menu on bookmark rows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  loadBookmarks: vi.fn().mockResolvedValue(["one.md", "two.md"]),
  saveBookmarks: vi.fn().mockResolvedValue(undefined),
}));

import { vaultStore } from "../../../store/vaultStore";
import { bookmarksStore } from "../../../store/bookmarksStore";
import BookmarksPanel from "../BookmarksPanel.svelte";

const VAULT = "/tmp/test-vault";

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerType?: string } = {},
): Event {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "touch", configurable: true });
  return ev;
}

describe("BookmarksPanel long-press → context menu (#387)", () => {
  beforeEach(async () => {
    vaultStore.reset();
    bookmarksStore.reset();
    vaultStore.setReady({
      currentPath: VAULT,
      fileList: ["one.md", "two.md"],
      fileCount: 2,
    });
    await bookmarksStore.load(VAULT);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the context menu after a 500ms touch hold on a bookmark row", async () => {
    const { container } = render(BookmarksPanel);
    await tick();

    const rows = container.querySelectorAll<HTMLElement>(".vc-bookmark-row");
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0]!;

    first.dispatchEvent(pointerEvent("pointerdown", { clientX: 80, clientY: 50 }));
    vi.advanceTimersByTime(500);
    await tick();

    const menu = container.querySelector(".vc-bookmark-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.top).toBe("50px");
    expect(menu.style.left).toBe("80px");
  });

  it("a second long-press on a different row replaces the menu state", async () => {
    const { container } = render(BookmarksPanel);
    await tick();

    const rows = container.querySelectorAll<HTMLElement>(".vc-bookmark-row");
    const [first, second] = [rows[0]!, rows[1]!];
    first.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(500);
    await tick();

    second.dispatchEvent(pointerEvent("pointerdown", { clientX: 200, clientY: 100 }));
    vi.advanceTimersByTime(500);
    await tick();

    const menu = container.querySelector(".vc-bookmark-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("100px");
  });

  it("desktop right-click contextmenu still opens the menu (coexistence)", async () => {
    const { container } = render(BookmarksPanel);
    await tick();
    const rows = container.querySelectorAll<HTMLElement>(".vc-bookmark-row");
    await fireEvent.contextMenu(rows[0]!, { clientX: 50, clientY: 30 });
    await tick();
    const menu = container.querySelector(".vc-bookmark-menu") as HTMLElement;
    expect(menu).toBeTruthy();
  });
});
