import { describe, it, expect } from "vitest";
import {
  DEFAULT_DAILY_DATE_FORMAT,
  dailyNoteFilename,
  formatDailyNoteDate,
  splitFolderSegments,
} from "../dailyNotes";

describe("dailyNotes helpers (#59)", () => {
  it("formats YYYY-MM-DD with zero-padding from a local Date", () => {
    // Use a local Date — getFullYear / getMonth / getDate are what the helper reads.
    const d = new Date(2024, 0, 7); // 2024-01-07 local
    expect(formatDailyNoteDate(d, DEFAULT_DAILY_DATE_FORMAT)).toBe("2024-01-07");
  });

  it("supports arbitrary placement of YYYY / MM / DD tokens", () => {
    const d = new Date(2025, 11, 31); // 2025-12-31 local
    expect(formatDailyNoteDate(d, "DD.MM.YYYY")).toBe("31.12.2025");
    expect(formatDailyNoteDate(d, "YYYY/MM/DD")).toBe("2025/12/31");
  });

  it("copies unknown characters through verbatim", () => {
    const d = new Date(2026, 3, 15);
    expect(formatDailyNoteDate(d, "journal-YYYY-MM-DD")).toBe("journal-2026-04-15");
  });

  it("dailyNoteFilename appends .md when absent", () => {
    const d = new Date(2026, 3, 15);
    expect(dailyNoteFilename(d, "YYYY-MM-DD")).toBe("2026-04-15.md");
  });

  it("dailyNoteFilename keeps an explicit .md extension in the format string", () => {
    const d = new Date(2026, 3, 15);
    expect(dailyNoteFilename(d, "YYYY-MM-DD.md")).toBe("2026-04-15.md");
  });

  it("dailyNoteFilename falls back to default format when rendered stem is empty", () => {
    const d = new Date(2026, 3, 15);
    expect(dailyNoteFilename(d, "   ")).toBe("2026-04-15.md");
  });

  it("splitFolderSegments drops empty and whitespace segments", () => {
    expect(splitFolderSegments("")).toEqual([]);
    expect(splitFolderSegments("/")).toEqual([]);
    expect(splitFolderSegments("Daily")).toEqual(["Daily"]);
    expect(splitFolderSegments("/Daily/2026/")).toEqual(["Daily", "2026"]);
    expect(splitFolderSegments("Daily\\Sub")).toEqual(["Daily", "Sub"]);
    expect(splitFolderSegments("Daily//Sub")).toEqual(["Daily", "Sub"]);
  });
});
