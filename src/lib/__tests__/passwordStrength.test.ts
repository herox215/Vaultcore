// #345 — password strength helper. Advisory only; does not block
// the encrypt flow. Tests pin the rule set so the EncryptFolder
// modal's 3-segment bar stays consistent across refactors.

import { describe, it, expect } from "vitest";

import {
  passwordStrength,
  passwordStrengthFillCount,
} from "../passwordStrength";

describe("passwordStrength", () => {
  it("classifies an empty string as 'empty'", () => {
    expect(passwordStrength("")).toBe("empty");
    expect(passwordStrengthFillCount("empty")).toBe(0);
  });

  it("classifies short alphabetic passwords as 'weak'", () => {
    expect(passwordStrength("abc")).toBe("weak");
    expect(passwordStrength("abcdef")).toBe("weak");
    expect(passwordStrengthFillCount("weak")).toBe(1);
  });

  it("classifies medium passwords with a digit OR symbol as 'ok'", () => {
    expect(passwordStrength("abcdefg1")).toBe("ok");
    expect(passwordStrength("abcdefgH!")).toBe("ok");
    expect(passwordStrengthFillCount("ok")).toBe(2);
  });

  it("classifies 12+ chars with digit AND symbol as 'strong'", () => {
    expect(passwordStrength("abcdefgh1234!")).toBe("strong");
    expect(passwordStrengthFillCount("strong")).toBe(3);
  });

  it("demotes to 'ok' when length drops below 12 even with digit+symbol", () => {
    expect(passwordStrength("a1!bcdef")).toBe("ok");
  });

  it("demotes to 'weak' when length drops below 8 even with digit", () => {
    expect(passwordStrength("a1b2")).toBe("weak");
  });
});
