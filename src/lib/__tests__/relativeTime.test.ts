import { describe, it, expect, vi, afterEach } from "vitest";
import { relativeTime } from "../relativeTime";

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  function freezeNow(unixSeconds: number): void {
    vi.useFakeTimers();
    vi.setSystemTime(unixSeconds * 1000);
  }

  it("renders nie for null / undefined", () => {
    expect(relativeTime(null)).toBe("nie");
    expect(relativeTime(undefined)).toBe("nie");
  });

  it("returns gerade eben for sub-45-second deltas", () => {
    freezeNow(10_000);
    expect(relativeTime(10_000)).toBe("gerade eben");
    expect(relativeTime(9_990)).toBe("gerade eben");
  });

  it("returns gerade eben for future timestamps (clock skew)", () => {
    freezeNow(10_000);
    expect(relativeTime(11_000)).toBe("gerade eben");
  });

  it("renders minutes with singular / plural distinction", () => {
    freezeNow(10_000);
    expect(relativeTime(10_000 - 60)).toBe("vor 1 Minute");
    expect(relativeTime(10_000 - 60 * 5)).toBe("vor 5 Minuten");
  });

  it("renders hours with singular / plural distinction", () => {
    freezeNow(10_000);
    expect(relativeTime(10_000 - 3600)).toBe("vor 1 Stunde");
    expect(relativeTime(10_000 - 3600 * 2)).toBe("vor 2 Stunden");
  });

  it("renders days and weeks", () => {
    freezeNow(10_000_000);
    expect(relativeTime(10_000_000 - 86400)).toBe("vor 1 Tag");
    expect(relativeTime(10_000_000 - 86400 * 3)).toBe("vor 3 Tagen");
    expect(relativeTime(10_000_000 - 86400 * 14)).toBe("vor 2 Wochen");
  });
});
