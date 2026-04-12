/**
 * EDIT-03: Fenced code blocks render with per-language syntax highlighting.
 *
 * This test is a regression guard asserting that the top-10 language labels
 * from CONTEXT D-17 resolve to a LanguageDescription in @codemirror/language-data.
 *
 * This does NOT test that colors appear on screen — that is covered by manual
 * verification in VALIDATION.md. What we guard here is the integration contract:
 * if @codemirror/language-data changes its naming or removes a language, CI catches it.
 *
 * Note on matchLanguageName API: the third argument is `fuzzy` (substring matching),
 * not an alias-only flag. We use fuzzy=false for exact name/alias matching so that
 * the unknown-language fallback test is reliable (substring matches are avoided).
 * The return type is LanguageDescription | null (not | undefined).
 */
import { describe, it, expect } from "vitest";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

describe("EDIT-03: @codemirror/language-data integration", () => {
  it("languages array is non-empty", () => {
    expect(Array.isArray(languages)).toBe(true);
    expect(languages.length).toBeGreaterThan(10);
  });

  it.each([
    ["javascript"],
    ["typescript"],
    ["rust"],
    ["python"],
    ["go"],
    ["html"],
    ["css"],
    ["shell"],
    ["json"],
    ["yaml"],
  ])("resolves language by canonical name: %s", (label) => {
    // fuzzy=false: exact name or alias match only (no substring guessing)
    const desc = LanguageDescription.matchLanguageName(languages as any, label, false);
    expect(desc, `expected language-data to include ${label}`).toBeTruthy();
  });

  it.each([
    // Common fence aliases supported by @codemirror/language-data aliases list.
    // Note: 'py' is NOT an alias in language-data (Python only registers 'python').
    ["js"],
    ["ts"],
    ["bash"],
    ["sh"],
  ])("resolves language by common alias: %s", (alias) => {
    const desc = LanguageDescription.matchLanguageName(languages as any, alias, false);
    expect(desc, `expected alias ${alias} to resolve`).toBeTruthy();
  });

  it("returns null for unknown language (D-18 fallback)", () => {
    // fuzzy=false ensures no substring match on the nonsense label.
    const desc = LanguageDescription.matchLanguageName(languages as any, "definitely-not-a-language-xyz", false);
    expect(desc).toBeNull();
  });
});
