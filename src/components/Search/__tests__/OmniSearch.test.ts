// #174 — OmniSearch is the unified replacement for QuickSwitcher + SearchPanel.
// Same modal shape as the old QuickSwitcher but with two modes (Dateien /
// Inhalt) and an auto-rebuild flow for a stale index. These tests lock in the
// contracts that downstream E2E specs and shortcuts rely on:
//   - mode-specific dispatch to the right backend command
//   - filename empty-state shows recents
//   - open-with-stale-index triggers rebuildIndex without a user click
//   - the status line under the input reflects the rebuild lifecycle
//   - tag-prefill opens in content mode with the query pre-run

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

vi.mock("../../../ipc/commands", () => ({
  searchFilename: vi.fn(),
  searchFulltext: vi.fn(),
  rebuildIndex: vi.fn(),
}));
vi.mock("../../../ipc/events", () => ({
  listenFileChange: vi.fn().mockResolvedValue(() => {}),
}));

import {
  searchFilename,
  searchFulltext,
  rebuildIndex,
} from "../../../ipc/commands";
import { vaultStore } from "../../../store/vaultStore";
import { searchStore } from "../../../store/searchStore";
import { tabStore } from "../../../store/tabStore";
import OmniSearch from "../OmniSearch.svelte";

const VAULT = "/tmp/vault-omni";

describe("OmniSearch (#174)", () => {
  beforeEach(() => {
    vaultStore.reset();
    searchStore.reset();
    tabStore.closeAll();
    vi.clearAllMocks();
    vaultStore.setReady({ currentPath: VAULT, fileList: [], fileCount: 0 });
  });

  function mountOpen(props: Partial<{
    initialMode: "filename" | "content";
    initialQuery: string;
    onOpenFile: (path: string) => void;
    onClose: () => void;
  }> = {}) {
    return render(OmniSearch, {
      props: {
        open: true,
        initialMode: props.initialMode ?? "filename",
        initialQuery: props.initialQuery,
        onClose: props.onClose ?? (() => {}),
        onOpenFile: props.onOpenFile ?? (() => {}),
      },
    });
  }

  // ── Mode switching ────────────────────────────────────────────────────

  it("opens in filename mode by default and renders the mode switcher", async () => {
    const { container } = mountOpen({ initialMode: "filename" });
    await tick();
    const fileTab = container.querySelector<HTMLButtonElement>(
      '[data-omni-mode="filename"]',
    );
    const contentTab = container.querySelector<HTMLButtonElement>(
      '[data-omni-mode="content"]',
    );
    expect(fileTab).toBeTruthy();
    expect(contentTab).toBeTruthy();
    expect(fileTab!.getAttribute("aria-pressed")).toBe("true");
    expect(contentTab!.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens in content mode when initialMode='content'", async () => {
    const { container } = mountOpen({ initialMode: "content" });
    await tick();
    const contentTab = container.querySelector<HTMLButtonElement>(
      '[data-omni-mode="content"]',
    );
    expect(contentTab!.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking the content tab switches mode and re-routes the active query", async () => {
    (searchFilename as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { container } = mountOpen({ initialMode: "filename" });
    await tick();

    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    await fireEvent.input(input, { target: { value: "foo" } });
    await tick();
    await Promise.resolve();
    expect(searchFilename).toHaveBeenCalled();

    const contentTab = container.querySelector<HTMLButtonElement>(
      '[data-omni-mode="content"]',
    )!;
    await fireEvent.click(contentTab);
    await tick();
    await Promise.resolve();
    expect(searchFulltext).toHaveBeenCalled();
  });

  // ── Backend dispatch per mode ─────────────────────────────────────────

  it("filename mode dispatches searchFilename on input", async () => {
    (searchFilename as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: "notes/alpha.md", score: 100, matchIndices: [] },
    ]);
    const { container } = mountOpen({ initialMode: "filename" });
    await tick();
    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    await fireEvent.input(input, { target: { value: "alpha" } });
    await tick();
    await Promise.resolve();
    expect(searchFilename).toHaveBeenCalledWith("alpha", 20);
    expect(searchFulltext).not.toHaveBeenCalled();
  });

  it("content mode dispatches searchFulltext on input", async () => {
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { container } = mountOpen({ initialMode: "content" });
    await tick();
    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    await fireEvent.input(input, { target: { value: "needle" } });
    await tick();
    await Promise.resolve();
    // Content mode is debounced (same 200ms as the old SearchPanel) —
    // verify it eventually fires.
    await new Promise((r) => setTimeout(r, 250));
    expect(searchFulltext).toHaveBeenCalled();
    expect(searchFilename).not.toHaveBeenCalled();
  });

  // ── Filename empty state shows recents ────────────────────────────────

  it("filename mode with empty query renders the recent-files section", async () => {
    tabStore.openTab(`${VAULT}/notes/recent.md`);
    const { container } = mountOpen({ initialMode: "filename" });
    await tick();
    const section = container.querySelector(".vc-qs-section-label");
    expect(section?.textContent).toMatch(/Zuletzt/);
  });

  // ── Auto-rebuild lifecycle ────────────────────────────────────────────

  it("auto-runs rebuildIndex when opened with a stale index and shows a status line", async () => {
    (rebuildIndex as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}), // never resolves — stays in rebuilding state
    );
    searchStore.setIndexStale(true);
    const { container } = mountOpen({ initialMode: "filename" });
    await tick();
    await Promise.resolve();

    expect(rebuildIndex).toHaveBeenCalledTimes(1);
    const status = container.querySelector(".vc-omni-status");
    expect(status).toBeTruthy();
    expect(status!.textContent).toMatch(/Index/);
    // The manual rebuild button must NOT exist anywhere on the page.
    expect(container.querySelector(".vc-search-rebuild-btn")).toBeNull();
  });

  it("clears the rebuild status line on success and flips indexStale off", async () => {
    (rebuildIndex as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    searchStore.setIndexStale(true);
    const { container } = mountOpen({ initialMode: "content" });
    await tick();
    // Wait a couple microtasks for rebuild to resolve.
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    let indexStale = false;
    const unsub = searchStore.subscribe((s) => { indexStale = s.indexStale; });
    unsub();
    expect(indexStale).toBe(false);
    expect(container.querySelector(".vc-omni-status")).toBeNull();
  });

  it("shows an error status line with retry link when rebuild fails", async () => {
    (rebuildIndex as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("boom"),
    );
    searchStore.setIndexStale(true);
    const { container } = mountOpen({ initialMode: "filename" });
    await tick();
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    const status = container.querySelector(".vc-omni-status");
    expect(status).toBeTruthy();
    expect(status!.textContent).toMatch(/fehlgeschlagen/i);
    expect(status!.querySelector(".vc-omni-status-retry")).toBeTruthy();
  });

  // ── Tag-prefill ───────────────────────────────────────────────────────

  it("initialQuery in content mode is placed in the input and runs the search", async () => {
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { container } = mountOpen({
      initialMode: "content",
      initialQuery: "#todo",
    });
    await tick();
    await Promise.resolve();
    await tick();

    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    expect(input.value).toBe("#todo");
    expect(searchFulltext).toHaveBeenCalled();
    const args = (searchFulltext as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toBe("#todo");
  });

  // ── Vault-switch reset (was the QuickSwitcher.vaultSwitch test) ───────

  it("resets query and filename results when the active vault changes", async () => {
    (searchFilename as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { path: "notes/alpha.md", score: 100, matchIndices: [] },
    ]);
    const { container } = mountOpen({ initialMode: "filename" });
    await tick();
    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    await fireEvent.input(input, { target: { value: "alpha" } });
    await tick();
    await Promise.resolve();
    await tick();
    expect(input.value).toBe("alpha");
    expect(container.querySelector(".vc-qs-results")?.textContent ?? "")
      .toContain("alpha.md");

    vaultStore.setReady({ currentPath: "/tmp/vault-other", fileList: [], fileCount: 0 });
    await tick();

    expect(input.value).toBe("");
    expect(container.querySelector(".vc-qs-results")?.textContent ?? "")
      .not.toContain("alpha.md");
  });

  // ── Keyboard / closing ────────────────────────────────────────────────

  it("Escape calls onClose", async () => {
    const onClose = vi.fn();
    const { container } = mountOpen({ onClose });
    await tick();
    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Backdrop click closes the modal ───────────────────────────────────
  // Regression: clicking outside the modal box used to leave the dialog open.

  it("clicking the backdrop calls onClose", async () => {
    const onClose = vi.fn();
    const { container } = mountOpen({ onClose });
    await tick();
    const backdrop = container.querySelector<HTMLElement>(
      ".vc-quick-switcher-backdrop",
    )!;
    expect(backdrop).toBeTruthy();
    await fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the modal box does NOT call onClose", async () => {
    const onClose = vi.fn();
    const { container } = mountOpen({ onClose });
    await tick();
    const modal = container.querySelector<HTMLElement>(
      ".vc-quick-switcher-modal",
    )!;
    await fireEvent.mouseDown(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── Issue #261 — k cap + debounce coalescing + recentFiles memoisation ─

  it("content mode coalesces a rapid 5-char keystroke burst into a single IPC call (#261)", async () => {
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { container } = mountOpen({ initialMode: "content" });
    await tick();
    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;

    // Type 5 characters within the 200ms debounce window. Each keystroke
    // must reset the trailing timer so only the last one actually dispatches.
    for (const ch of ["n", "ne", "nee", "need", "needl"]) {
      await fireEvent.input(input, { target: { value: ch } });
      // Small wait < debounce delay — simulates a ~40ms-per-key typist.
      await new Promise((r) => setTimeout(r, 40));
    }
    // No debounce firing yet.
    expect(searchFulltext).toHaveBeenCalledTimes(0);

    // Flush the debounce tail.
    await new Promise((r) => setTimeout(r, 260));
    expect(searchFulltext).toHaveBeenCalledTimes(1);
  });

  it("content mode requests a small k by default (viewport-sized, <= 30) (#261)", async () => {
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { container } = mountOpen({ initialMode: "content" });
    await tick();
    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    await fireEvent.input(input, { target: { value: "needle" } });
    await new Promise((r) => setTimeout(r, 260));
    expect(searchFulltext).toHaveBeenCalledTimes(1);
    const args = (searchFulltext as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const kArg = args[1] as number;
    expect(kArg).toBeLessThanOrEqual(30);
    expect(kArg).toBeGreaterThan(0);
  });

  it("renders a load-more affordance when results are capped at k and expanding refetches with larger k (#261)", async () => {
    const INITIAL_K = 20;
    const BIG_HIT_LIST: SearchResult[] = Array.from({ length: INITIAL_K }, (_, i) => ({
      path: `notes/hit-${i}.md`,
      title: `hit-${i}`,
      score: 1 - i / 100,
      snippet: "s",
      matchCount: 0,
    }));
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(BIG_HIT_LIST);
    const { container } = mountOpen({ initialMode: "content" });
    await tick();
    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    await fireEvent.input(input, { target: { value: "needle" } });
    await new Promise((r) => setTimeout(r, 260));
    await tick();
    await Promise.resolve();
    await tick();

    // First call used the small default k.
    const firstArgs = (searchFulltext as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(firstArgs[1]).toBeLessThanOrEqual(30);

    const loadMore = container.querySelector<HTMLButtonElement>(".vc-omni-load-more");
    expect(loadMore).toBeTruthy();

    await fireEvent.click(loadMore!);
    // Clicking load-more dispatches a fresh search with a larger k.
    expect(searchFulltext).toHaveBeenCalledTimes(2);
    const secondArgs = (searchFulltext as unknown as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(secondArgs[0]).toBe("needle");
    expect(secondArgs[1] as number).toBeGreaterThan(firstArgs[1] as number);
  });


  // ── Cursor position preservation while typing (regression) ────────────
  // The content-mode debounce + async search used to re-sync bind:value while
  // the search was in-flight, occasionally resetting the caret to position 0.
  // This test caret-positions into the middle of the value, then lets the
  // debounce fire — the caret must stay where the user left it.

  it("preserves the caret position across a debounced content-mode search", async () => {
    let resolveFulltext!: (v: SearchResult[]) => void;
    (searchFulltext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<SearchResult[]>((r) => { resolveFulltext = r; }),
    );
    const { container } = mountOpen({ initialMode: "content" });
    await tick();

    const input = container.querySelector<HTMLInputElement>(".vc-qs-input")!;
    input.focus();
    // Simulate the user having typed "hello" and positioned the caret in the
    // middle of the word.
    await fireEvent.input(input, { target: { value: "hello" } });
    input.setSelectionRange(3, 3);
    expect(input.selectionStart).toBe(3);

    // Wait past the 200ms debounce so the search actually fires, then resolve
    // the IPC promise. This is exactly the window where storeState updates
    // used to cascade into a bind:value re-sync that moved the caret.
    await new Promise((r) => setTimeout(r, 260));
    expect(searchFulltext).toHaveBeenCalled();
    resolveFulltext([]);
    await Promise.resolve();
    await tick();
    await Promise.resolve();

    expect(input.value).toBe("hello");
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
  });
});

// Type re-import so the mock type cast above compiles.
import type { SearchResult } from "../../../types/search";
