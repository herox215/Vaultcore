import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import SearchInput from "../SearchInput.svelte";

describe("SearchInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("user-typing: characters persist and onSearch fires after debounce", async () => {
    const onSearch = vi.fn();
    render(SearchInput, { props: { onSearch, disabled: false, externalValue: "" } });

    const input = screen.getByRole("searchbox") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "rust" } });
    expect(input.value).toBe("rust");

    // onSearch not yet fired (debounced)
    expect(onSearch).not.toHaveBeenCalled();

    // advance past 200ms debounce
    vi.advanceTimersByTime(200);
    expect(onSearch).toHaveBeenCalledWith("rust");
  });

  it("external-value-changes: re-render with new externalValue seeds the input", async () => {
    const onSearch = vi.fn();
    const { rerender } = render(SearchInput, {
      props: { onSearch, disabled: false, externalValue: "" },
    });

    const input = screen.getByRole("searchbox") as HTMLInputElement;
    expect(input.value).toBe("");

    await rerender({ onSearch, disabled: false, externalValue: "hello" });
    await tick();

    expect(input.value).toBe("hello");
  });

  it("no-reset: typing does not get overwritten by stale externalValue before debounce fires", async () => {
    const onSearch = vi.fn();
    render(SearchInput, { props: { onSearch, disabled: false, externalValue: "" } });

    const input = screen.getByRole("searchbox") as HTMLInputElement;

    // User types "a" — externalValue is still "" (debounce not yet fired)
    await fireEvent.input(input, { target: { value: "a" } });
    await tick();

    // Input must not have been reset to ""
    expect(input.value).toBe("a");
  });

  it("concurrent: external update wins over in-flight user keystroke", async () => {
    const onSearch = vi.fn();
    const { rerender } = render(SearchInput, {
      props: { onSearch, disabled: false, externalValue: "" },
    });

    const input = screen.getByRole("searchbox") as HTMLInputElement;

    // User types "a" but debounce has not fired yet
    await fireEvent.input(input, { target: { value: "a" } });
    await tick();
    expect(input.value).toBe("a");

    // External caller (TagsPanel tag-click) updates store before debounce fires
    await rerender({ onSearch, disabled: false, externalValue: "xyz" });
    await tick();

    // External value wins
    expect(input.value).toBe("xyz");
  });
});
