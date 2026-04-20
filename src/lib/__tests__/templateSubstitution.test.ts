// Unit tests for templateSubstitution (#132). The module has three
// substitutions — {{date}}, {{time}}, {{title}} — and uses `new Date()` so
// we freeze the clock with vitest's fake timers to get deterministic
// output without touching the module source.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { substituteTemplateVars } from "../templateSubstitution";
import { createVaultRoot } from "../vaultApi";

describe("substituteTemplateVars", () => {
  beforeEach(() => {
    // Pin to a local wall-clock instant with one-digit month/day/hour/minute
    // so the zero-padding of each field is exercised.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 4, 7, 3));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("substitutes {{date}} with YYYY-MM-DD (zero-padded)", () => {
    expect(substituteTemplateVars("Today is {{date}}.", "note")).toBe(
      "Today is 2026-01-04.",
    );
  });

  it("substitutes {{time}} with HH:mm (zero-padded)", () => {
    expect(substituteTemplateVars("At {{time}}", "note")).toBe("At 07:03");
  });

  it("substitutes {{title}} with the note title (whatever string is passed)", () => {
    expect(substituteTemplateVars("Title: {{title}}", "My Note")).toBe(
      "Title: My Note",
    );
  });

  it("replaces all occurrences of a variable, not just the first", () => {
    expect(
      substituteTemplateVars("{{title}} / {{title}} / {{title}}", "X"),
    ).toBe("X / X / X");
  });

  it("supports all three substitutions in one string", () => {
    expect(
      substituteTemplateVars("{{date}} {{time}} — {{title}}", "Diary"),
    ).toBe("2026-01-04 07:03 — Diary");
  });

  it("leaves unknown placeholders untouched", () => {
    // Only the three documented tokens are replaced — a surface like
    // {{author}} must round-trip unchanged so templates stay forgiving.
    expect(
      substituteTemplateVars(
        "{{author}} wrote on {{date}} - {{unknown}}",
        "Sample",
      ),
    ).toBe("{{author}} wrote on 2026-01-04 - {{unknown}}");
  });

  it("handles an empty template (returns empty string)", () => {
    expect(substituteTemplateVars("", "Title")).toBe("");
  });

  it("handles an empty title and still substitutes everything else", () => {
    expect(substituteTemplateVars("[{{title}}] {{date}}", "")).toBe(
      "[] 2026-01-04",
    );
  });

  it("does not treat the title as a template — literal {{date}} in the title stays literal", () => {
    // If title substitution happened before date (or the code naively
    // replaced substrings in-place), a title of `{{date}}` would get a
    // second-pass expansion. We rely on the implementation running the
    // three replacements sequentially against the original content only.
    expect(
      substituteTemplateVars("Title: {{title}} / Date: {{date}}", "{{date}}"),
    ).toBe("Title: {{date}} / Date: 2026-01-04");
  });

  it("handles midnight (00:00) and end-of-year double-digit values", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 0, 0));
    expect(substituteTemplateVars("{{date}} {{time}}", "x")).toBe(
      "2026-12-31 00:00",
    );
  });
});

describe("substituteTemplateVars — vault expressions (#283)", () => {
  // Reuse the fake-timer setup from the outer block for date-sensitive tests.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 4, 7, 3));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const vaultRoot = createVaultRoot({
    readVault: () => ({
      name: "MyVault",
      path: "/v/MyVault",
      fileList: ["a.md", "b.md", "c.md"],
    }),
    readTags: () => [{ tag: "#idea", count: 2 }],
    readBookmarks: () => [],
    readNoteContent: () => null,
  });

  it("substitutes {{vault.name}} with the current vault name", () => {
    expect(
      substituteTemplateVars("Vault: {{vault.name}}", "t", { vaultRoot }),
    ).toBe("Vault: MyVault");
  });

  it("substitutes {{vault.notes.count()}} with the note count", () => {
    expect(
      substituteTemplateVars("{{vault.notes.count()}} notes", "t", { vaultRoot }),
    ).toBe("3 notes");
  });

  it("evaluates where/select chains to comma-separated strings", () => {
    expect(
      substituteTemplateVars(
        "{{vault.notes.where(n => n.name == 'a.md').select(n => n.title).toArray()}}",
        "t",
        { vaultRoot },
      ),
    ).toBe("a");
  });

  it("renders unknown identifiers as inline errors (not crashes)", () => {
    const out = substituteTemplateVars("{{bogus}}", "t", { vaultRoot });
    expect(out).toMatch(/^\{\{!err:/);
  });

  it("still renders {{date}}/{{time}}/{{title}} when vaultRoot is given", () => {
    expect(
      substituteTemplateVars("{{title}} @ {{date}}", "x", { vaultRoot }),
    ).toBe("x @ 2026-01-04");
  });
});
