// Tests for the shared template scope builder (#322).
// The scope returned by `buildTemplateScope` feeds both the CM6 live-preview
// and the Reading Mode renderer; keeping its shape locked down via tests
// prevents a drift where one view resolves an identifier the other doesn't.

import { describe, it, expect, beforeEach } from "vitest";

import {
  buildTemplateScope,
  formatDate,
  formatTime,
  titleFromPath,
} from "../templateScope";
import { vaultStore } from "../../store/vaultStore";
import { editorStore } from "../../store/editorStore";

beforeEach(() => {
  vaultStore.setReady({ currentPath: "/tmp/vault", fileList: [], fileCount: 0 });
  editorStore.close();
});

describe("formatDate / formatTime", () => {
  it("pads single-digit months, days, hours, and minutes", () => {
    const d = new Date(2026, 0, 5, 3, 7, 0); // Jan 5 03:07
    expect(formatDate(d)).toBe("2026-01-05");
    expect(formatTime(d)).toBe("03:07");
  });
});

describe("titleFromPath", () => {
  it("strips the .md extension and any leading directories", () => {
    expect(titleFromPath("folder/sub/MyNote.md")).toBe("MyNote");
  });

  it("leaves non-.md basenames untouched", () => {
    expect(titleFromPath("assets/image.png")).toBe("image.png");
  });

  it("returns empty string for null / empty input", () => {
    expect(titleFromPath(null)).toBe("");
    expect(titleFromPath("")).toBe("");
  });
});

describe("buildTemplateScope", () => {
  it("exposes vault, date, time, title bindings", () => {
    const scope = buildTemplateScope({
      now: new Date(2026, 3, 21, 12, 34),
      title: "Explicit",
    });
    expect(scope).toHaveProperty("vault");
    expect(scope.date).toBe("2026-04-21");
    expect(scope.time).toBe("12:34");
    expect(scope.title).toBe("Explicit");
  });

  it("falls back to the active editor tab's basename when title is omitted", () => {
    editorStore.openFile("folder/Fallback.md", "");
    const scope = buildTemplateScope();
    expect(scope.title).toBe("Fallback");
  });
});
