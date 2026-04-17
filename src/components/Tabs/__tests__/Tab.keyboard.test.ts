import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import Tab from "../Tab.svelte";
import type { Tab as TabType } from "../../../store/tabStore";

/**
 * Keyboard activation for tabs (#117).
 *
 * A tab must be activatable via Enter and Space to satisfy the ARIA tab
 * pattern — clicking alone excludes keyboard-only users. Space must also
 * preventDefault so the browser does not scroll the tablist container.
 */

function makeTab(id: string, path = "/vault/notes/a.md"): TabType {
  return {
    id,
    filePath: path,
    isDirty: false,
    scrollPos: 0,
    cursorPos: 0,
    lastSaved: 0,
    lastSavedContent: "",
  };
}

describe("Tab keyboard activation (#117)", () => {
  it("Enter on the tab fires onactivate", async () => {
    const onactivate = vi.fn();
    const onclose = vi.fn();
    render(Tab, {
      props: {
        tab: makeTab("t1"),
        isActive: true,
        onactivate,
        onclose,
      },
    });

    const tabEl = screen.getByRole("tab");
    await fireEvent.keyDown(tabEl, { key: "Enter" });
    expect(onactivate).toHaveBeenCalledTimes(1);
  });

  it("Space on the tab fires onactivate and prevents default scroll", async () => {
    const onactivate = vi.fn();
    const onclose = vi.fn();
    render(Tab, {
      props: {
        tab: makeTab("t2"),
        isActive: true,
        onactivate,
        onclose,
      },
    });

    const tabEl = screen.getByRole("tab");
    // fireEvent.keyDown returns false if preventDefault was called.
    const notDefaulted = await fireEvent.keyDown(tabEl, { key: " " });
    expect(onactivate).toHaveBeenCalledTimes(1);
    // The handler must call preventDefault on Space to stop the browser from
    // scrolling the tablist container.
    expect(notDefaulted).toBe(false);
  });

  it("other keys do not fire onactivate", async () => {
    const onactivate = vi.fn();
    const onclose = vi.fn();
    render(Tab, {
      props: {
        tab: makeTab("t3"),
        isActive: true,
        onactivate,
        onclose,
      },
    });

    const tabEl = screen.getByRole("tab");
    await fireEvent.keyDown(tabEl, { key: "a" });
    await fireEvent.keyDown(tabEl, { key: "ArrowDown" });
    await fireEvent.keyDown(tabEl, { key: "Escape" });
    expect(onactivate).not.toHaveBeenCalled();
  });
});
